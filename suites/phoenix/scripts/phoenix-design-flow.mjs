import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const supportedActions = [
  "user-submit-materials",
  "user-inspect-theme-dialog",
  "user-inspect-material-section",
  "user-resubmit-materials",
  "admin-approve-materials",
  "admin-approve-design",
  "admin-reject-materials",
  "admin-inspect-material-reject",
  "admin-inspect-status-dialog",
  "admin-assign-designer",
  "admin-inspect-assign-designer",
  "designer-start",
  "designer-submit-review",
  "designer-verify-modification",
  "user-accept",
  "user-reject",
  "admin-status",
  "main-flow",
  "reject-branches-flow",
];

const adminStatusCandidates = [
  "资料未提交",
  "资料审核中",
  "资料审核未通过",
  "审核未通过",
  "资料审核不通过",
  "未分配",
  "已分配",
  "设计中",
  "设计审核中",
  "设计师审核中",
  "用户审核中",
  "用户不通过",
  "用户通过",
];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function showHelp() {
  console.log(`Phoenix 设计任务流程脚本

用法：
  node scripts/phoenix-design-flow.mjs --action <动作> [--config 配置文件] [--site 网站名称] [--headless]

动作：
  ${supportedActions.join("\n  ")}

说明：
  默认使用有界面浏览器。--site 可只运行配置中的一个网站；不传则批量运行 sites。
  密码优先从账号配置的 passwordEnv 环境变量读取，也可放在仅本地使用的 *.local.json 中。`);
}

function formatLocalDate(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function timestampForFile() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function beijingTimestamp(date = new Date()) {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date).replaceAll("/", "-");
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

function mergeSite(defaults, site) {
  return { ...defaults, ...site };
}

function credential(config, role) {
  const item = config.accounts?.[role];
  if (!item?.account) throw new Error(`配置缺少 ${role} 账号`);
  const password = (item.passwordEnv && process.env[item.passwordEnv])
    || (item.fallbackPasswordEnv && process.env[item.fallbackPasswordEnv])
    || item.password;
  if (!password) {
    const envNames = [item.passwordEnv, item.fallbackPasswordEnv].filter(Boolean).join(" 或 ");
    throw new Error(`${role} 账号缺少密码，请设置环境变量 ${envNames}，或在本地 *.local.json 中配置 password`);
  }
  return { account: item.account, password };
}

function proxyOption(proxy) {
  if (!proxy || ["none", "direct", "off"].includes(String(proxy).toLowerCase())) return undefined;
  return { server: proxy };
}

async function visible(locator) {
  return locator.isVisible().catch(() => false);
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const current = locator.nth(index);
    if (await visible(current)) return current;
  }
  return null;
}

async function centerClick(locator, options = {}) {
  await locator.waitFor({ state: "attached", timeout: options.timeout ?? 15_000 });
  await locator.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
  await locator.page().waitForTimeout(250);
  await locator.click({ timeout: options.timeout ?? 15_000 });
}

async function clickVisibleText(pageOrFrame, text, options = {}) {
  const locator = pageOrFrame.getByText(text, { exact: options.exact ?? true });
  const target = await firstVisible(locator);
  if (!target) return false;
  await centerClick(target, options);
  return true;
}

async function waitForSettled(page, milliseconds = 1_000) {
  await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(milliseconds);
}

async function gotoPage(page, url, config, options = {}) {
  try {
    return await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000, ...options });
  } catch (error) {
    const currentUrl = page.url();
    const loginFormVisible = await visible(page.locator("#loginName")).catch(() => false);
    if (currentUrl !== "about:blank" && !loginFormVisible) {
      await waitForSettled(page, 1_000);
      console.log(`[页面导航] ${url} 等待超时，但当前页面已可用：${currentUrl}`);
      return null;
    }
    throw error;
  }
}

async function login(page, config, credentials) {
  const entryUrl = config.urls.login;
  const environment = config.environment || {};
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await page.goto(entryUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(1_500);
    const currentUrl = new URL(page.url());
    if (environment.entryProtocol && new URL(entryUrl).protocol !== environment.entryProtocol) {
      throw new Error(`环境入口协议不匹配：期望 ${environment.entryProtocol}，实际 ${new URL(entryUrl).protocol}`);
    }
    if (environment.expectedHostname && currentUrl.hostname !== environment.expectedHostname) {
      throw new Error(`环境主机不匹配：期望 ${environment.expectedHostname}，实际 ${currentUrl.hostname}`);
    }
    if (environment.requiredHeaderName) {
      const headers = await response?.allHeaders().catch(() => ({})) || {};
      const actual = headers[environment.requiredHeaderName.toLowerCase()] || "";
      if (!actual.toLowerCase().includes(String(environment.requiredHeaderValue || "").toLowerCase())) {
        throw new Error(`灰度响应头校验失败：${environment.requiredHeaderName}=${actual || "<empty>"}`);
      }
    }
    const loginName = page.locator("#loginName");
    if (!(await visible(loginName))) return;
    await loginName.fill(credentials.account);
    await page.locator("#password").fill(credentials.password);
    await centerClick(page.locator("#loginSubmit"));
    await waitForSettled(page, 3_000);
    if (!(await visible(loginName))) return;
    if (attempt < 3) await page.waitForTimeout(2_000);
  }
  throw new Error(`登录后仍停留在 ${entryUrl}，已重试 3 次`);
}

async function enterCloudPlatform(page) {
  const avatar = await firstVisible(page.locator(".wrap-login-container, .wrap-login-dropdown, [class*='avatar']"));
  if (avatar) {
    await avatar.hover().catch(() => undefined);
    await page.waitForTimeout(300);
  }
  const cloudLink = await firstVisible(page.getByText(/(?:进入|返回)?领动云平台/u));
  if (cloudLink) {
    await centerClick(cloudLink);
    await waitForSettled(page, 2_000);
  }
}

async function ensureSiteVisible(page, config, site) {
  const findMarker = async () => {
    const byName = await firstVisible(page.getByText(site.name, { exact: true }));
    if (byName) return byName;
    if (site.frontUrl) {
      const normalized = site.frontUrl.replace(/\/$/u, "");
      const byUrl = await firstVisible(page.getByText(normalized, { exact: true }))
        || await firstVisible(page.locator(`a[href^=${JSON.stringify(normalized)}]`));
      if (byUrl) return byUrl;
    }
    return null;
  };
  const waitForMarker = async (attempts = 12) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const marker = await findMarker();
      if (marker) return marker;
      await page.waitForTimeout(1_000);
    }
    return null;
  };
  let siteText = await waitForMarker(4);
  if (siteText) return siteText;
  await enterCloudPlatform(page);
  siteText = await waitForMarker(8);
  if (siteText) return siteText;
  await gotoPage(page, config.urls.cloudHome, config);
  await waitForSettled(page, 3_000);
  siteText = await waitForMarker(12);
  if (!siteText) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await waitForSettled(page, 3_000);
    siteText = await waitForMarker(12);
  }
  if (!siteText) throw new Error(`未在领动云平台找到网站：${site.name}`);
  return siteText;
}

async function siteCardAction(page, config, site, actionText) {
  const siteText = await ensureSiteVisible(page, config, site);
  const card = siteText.locator(`xpath=ancestor::*[.//*[normalize-space()=${JSON.stringify(actionText)}]][1]`);
  let action = await firstVisible(card.getByText(actionText, { exact: true }));
  if (!action) action = await firstVisible(page.getByText(actionText, { exact: true }));
  if (!action) throw new Error(`${site.name} 未找到操作“${actionText}”`);
  await centerClick(action);
  await waitForSettled(page, 1_500);
}

async function siteCardActionAny(page, config, site, actionTexts) {
  const siteText = await ensureSiteVisible(page, config, site);
  for (const actionText of actionTexts) {
    const card = siteText.locator(`xpath=ancestor::*[.//*[normalize-space()=${JSON.stringify(actionText)}]][1]`);
    let action = await firstVisible(card.getByText(actionText, { exact: true }));
    if (!action) action = await firstVisible(page.getByText(actionText, { exact: true }));
    if (action) {
      await centerClick(action);
      await waitForSettled(page, 1_500);
      return actionText;
    }
  }
  throw new Error(`${site.name} 未找到操作：${actionTexts.join(" / ")}`);
}

function fallbackValue(input, site) {
  const type = (input.type || "").toLowerCase();
  const hint = `${input.name || ""} ${input.id || ""} ${input.placeholder || ""}`.toLowerCase();
  if (type === "email" || hint.includes("mail") || hint.includes("邮箱")) return "automation@example.com";
  if (type === "tel" || /phone|mobile|电话|手机/u.test(hint)) return "13800138000";
  if (type === "url" || /url|网址|网站/u.test(hint)) return "https://example.com";
  if (type === "number") return "1";
  if (type === "date") return new Date().toISOString().slice(0, 10);
  return `${site.formText || "自动化测试资料"}-${site.name}`;
}

async function fillCurrentMaterialForm(page, site) {
  const uploadFile = site.uploadFile;
  if (uploadFile) await fs.access(uploadFile);

  const save = page.locator("#customerInfoSubmitNew:visible");
  const form = save.locator("xpath=ancestor::form[1]");
  const scope = await form.count() ? form : page;

  const uploadNames = await scope.locator('input[type="file"][uploadname]').evaluateAll((items) => [...new Set(items.map((item) => item.getAttribute("uploadname")).filter(Boolean))]);
  for (const uploadName of uploadNames) {
    if (!uploadFile) break;
    const input = scope.locator(`input[type="file"][uploadname=${JSON.stringify(uploadName)}]`).first();
    if (!(await input.count())) continue;
    const uploadContainer = input.locator("xpath=ancestor::*[contains(@class, 'materials-form-uploadfix')][1]");
    if (await uploadContainer.count()) {
      const hasSavedFile = await uploadContainer.locator('input[type="hidden"][value]:not([value=""])').count();
      if (hasSavedFile) continue;
    }
    const current = await input.inputValue().catch(() => "");
    if (current) continue;
    await input.setInputFiles(uploadFile);
    // 页面 onchange 会先上传文件，再把附件元数据写回表单；等待完成后再处理下一个控件。
    await page.waitForTimeout(3_000);
  }
  await scope.locator('input[type="hidden"][name]').evaluateAll((items) => {
    const groups = new Map();
    for (const item of items) {
      if (!/fileId|fileName|fileUrl/u.test(item.name || "")) continue;
      if (!groups.has(item.name)) groups.set(item.name, []);
      groups.get(item.name).push(item);
    }
    for (const fields of groups.values()) {
      const populated = [...fields].reverse().find((field) => Boolean(field.value));
      if (!populated) continue;
      for (const field of fields) field.value = populated.value;
    }
  });

  const textControls = scope.locator('input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="url"], input[type="number"], input[type="date"], textarea');
  for (let index = 0; index < await textControls.count(); index += 1) {
    const control = textControls.nth(index);
    if (!(await visible(control))) continue;
    if (await control.isDisabled().catch(() => true)) continue;
    if (await control.getAttribute("readonly")) continue;
    if (await control.inputValue().catch(() => "")) continue;
    const meta = await control.evaluate((element) => ({
      type: element.getAttribute("type"),
      name: element.getAttribute("name"),
      id: element.id,
      placeholder: element.getAttribute("placeholder"),
    }));
    await control.fill(fallbackValue(meta, site)).catch(() => undefined);
  }

  const selects = scope.locator("select");
  for (let index = 0; index < await selects.count(); index += 1) {
    const select = selects.nth(index);
    if (!(await visible(select)) || await select.isDisabled().catch(() => true)) continue;
    const selected = await select.inputValue().catch(() => "");
    if (selected) continue;
    const option = await select.locator("option").evaluateAll((items) => items.map((item) => ({ value: item.value, disabled: item.disabled })).find((item) => item.value && !item.disabled));
    if (option?.value) await select.selectOption(option.value).catch(() => undefined);
  }

  const editables = scope.locator('[contenteditable="true"]');
  for (let index = 0; index < await editables.count(); index += 1) {
    const editable = editables.nth(index);
    if (!(await visible(editable))) continue;
    if ((await editable.innerText().catch(() => "")).trim()) continue;
    await editable.fill(`${site.formText || "自动化测试资料"}-${site.name}`).catch(() => undefined);
  }

  const radioNames = await scope.locator('input[type="radio"]:visible').evaluateAll((items) => [...new Set(items.map((item) => item.name).filter(Boolean))]);
  for (const name of radioNames) {
    const checked = page.locator(`input[type="radio"][name=${JSON.stringify(name)}]:checked`);
    if (await checked.count()) continue;
    const option = await firstVisible(page.locator(`input[type="radio"][name=${JSON.stringify(name)}]`));
    if (option) await option.check({ force: true }).catch(() => undefined);
  }
}

async function clickMaterialSection(page, index) {
  const link = page.locator(`a[onclick*="redirectLabel('${index}')"]`);
  await link.waitFor({ state: "attached", timeout: 15_000 });
  await link.evaluate((element) => element.click());
  await page.waitForTimeout(800);
  await dismissMaterialDialogs(page);
}

async function hasMaterialAttachment(page, nameFragment) {
  return page.locator(`input[type="hidden"][name*=${JSON.stringify(nameFragment)}]`)
    .evaluateAll((items) => items.some((item) => Boolean(item.value)));
}

async function uploadMaterialAttachment(page, button, filePath) {
  await fs.access(filePath);
  await page.waitForTimeout(2_000);
  await button.click({ force: true });
  // 上传 iframe 会延迟创建，实测至少需要等待 2 秒。
  await page.waitForTimeout(2_000);
  let uploadFrame = null;
  for (let attempt = 0; attempt < 24 && !uploadFrame; attempt += 1) {
    for (const frame of [...page.frames()].reverse()) {
      const fileInput = frame.locator('input[type="file"]');
      if (frame.url().includes("media.leadong.com") && await fileInput.count()) {
        uploadFrame = frame;
        break;
      }
    }
    if (attempt === 7 && !uploadFrame) {
      await button.evaluate((element) => {
        const uploadName = element.querySelector("input")?.getAttribute("uploadname");
        const addAnnexs = window.phoenixSite?.siteInfo?.addAnnexs;
        if (uploadName && typeof addAnnexs === "function") addAnnexs(element, 5, uploadName);
        else element.click();
      }).catch(() => undefined);
    }
    if (!uploadFrame) await page.waitForTimeout(500);
  }
  if (!uploadFrame) throw new Error("等待 2 秒后仍未找到资料上传控件");
  await uploadFrame.locator('input[type="file"]').setInputFiles(filePath);
  const uploadStart = uploadFrame.locator("#uploadStart");
  await uploadStart.waitFor({ state: "visible", timeout: 10_000 });
  await uploadStart.click({ force: true });
  await page.getByText("选择文件", { exact: true }).first().waitFor({ state: "hidden", timeout: 20_000 });
  await page.waitForTimeout(5_000);
}

async function fillKnownMaterialSection(page, site, index) {
  await fillCurrentMaterialForm(page, site);
  const value = `${site.formText || "自动化测试资料"}-${site.name}`;

  if (index === 0) {
    await page.locator('input[name="siteStyle.themeNo[0]"]').fill(String(site.themeNo || "238"));
    await page.locator('input[name="siteStyle.industry"]').fill(`${value}主营产品`);
  } else if (index === 1) {
    for (const [selector, color] of [["#webThemeColor", site.primaryColor || "#1E88E5"], ["#webThemeSecondaryColor", site.secondaryColor || "#F5A623"]]) {
      const input = page.locator(selector);
      if (!(await input.count())) continue;
      await input.evaluate((element, nextColor) => {
        const jq = window.jQuery;
        element.removeAttribute("readonly");
        element.value = nextColor;
        if (jq && typeof jq(element).spectrum === "function") jq(element).spectrum("set", nextColor);
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }, color);
    }
  } else if (index === 3) {
    const categoryUpload = page.locator('a.uploadsimp-button:has(input[uploadname="baseData.prodCateAnnexJson"])');
    const productUpload = page.locator('a.uploadsimp-button:has(input[uploadname="baseData.prodAnnexJson"])');
    if (!await hasMaterialAttachment(page, "prodCateAnnexJson")) await uploadMaterialAttachment(page, categoryUpload, site.uploadFile);
    if (!await hasMaterialAttachment(page, "prodAnnexJson")) await uploadMaterialAttachment(page, productUpload, site.uploadFile);
    const productCategory = await firstVisible(page.locator('textarea[name="baseData.prodCategory"]'));
    const productDescription = await firstVisible(page.locator('textarea[name="baseData.product"]'));
    if (!productCategory || !productDescription) throw new Error("产品资料可见文本框未找到");
    await productCategory.fill(`${value}产品分类\n- ${value}子分类`);
    await productDescription.fill(`${value}产品详情资料`);
  } else if (index === 4) {
    const newsUpload = page.locator('a.uploadsimp-button:has(input[uploadname="baseData.newsAnnexJson"])');
    if (!await hasMaterialAttachment(page, "newsAnnexJson")) await uploadMaterialAttachment(page, newsUpload, site.uploadFile);
    const newsCategory = await firstVisible(page.locator('textarea[name="baseData.newsCateDesc"]'));
    const newsDescription = await firstVisible(page.locator('textarea[name="baseData.newsDesc"]'));
    if (!newsCategory || !newsDescription) throw new Error("新闻资料可见文本框未找到");
    await newsCategory.fill("公司新闻");
    await newsDescription.fill(`${value}新闻资料`);
  } else if (index === 5) {
    const faq = page.locator('textarea[name="baseData.faqDesc"]');
    if (await faq.count()) await faq.fill("Q：自动化测试问题\nA：自动化测试答案");
    const fieldName = page.locator('input[name="baseData.baseDataAppend[0].fieldName"]');
    if (await fieldName.count()) await fieldName.fill("测试补充资料");
    const appendText = page.locator('textarea[name="baseData.baseDataAppend[0].appendText"]');
    if (await appendText.count()) await appendText.fill(`${value}补充内容`);
  } else if (index === 6) {
    await page.locator('input[name="contactInfo.mobilePhone"]').fill("+86-138-0013-8000");
    await page.locator('input[name="contactInfo.comAddress"]').fill("江苏省南京市自动化测试地址");
    await page.locator('input[name="contactInfo.email"]').fill("automation@example.com");
    await page.locator('input[name="contactInfo.inquiryEmail"]').fill("inquiry@example.com");
    const whatsApp = page.locator('input[name="contactInfo.whatsApp"]');
    if (await whatsApp.count()) await whatsApp.fill("+86-138-0013-8000");
    const phone = page.locator('input[name="contactInfo.phone"]');
    if (await phone.count()) await phone.fill("+86-25-88888888");
    for (const optionalName of ["contactInfo.skype", "contactInfo.youtube", "contactInfo.facebook", "contactInfo.pinterest", "contactInfo.zipCode", "contactInfo.fax", "contactInfo.qq"]) {
      const optional = page.locator(`input[name=${JSON.stringify(optionalName)}]`);
      if (await optional.count()) await optional.fill("");
    }
    const customName = page.locator('input[name="contactInfo.contactDefines[0].fieldName"]');
    const customValue = page.locator('input[name="contactInfo.contactDefines[0].fieldValue"]');
    if (await customName.count()) await customName.fill("");
    if (await customValue.count()) await customValue.fill("");
  } else if (index === 7) {
    await page.locator('input[name="siteSeo.siteTitle"]').fill(site.name);
    const keywords = page.locator('input[name="siteSeo.siteKeyword"]');
    const keywordValues = ["automation", "website", "test", "design", "service"];
    for (let keywordIndex = 0; keywordIndex < await keywords.count(); keywordIndex += 1) {
      await keywords.nth(keywordIndex).fill(keywordValues[keywordIndex] || `keyword${keywordIndex + 1}`);
    }
    await page.locator('input[name="siteSeo.siteDomain"]').fill((site.frontUrl || "需注册").replace(/^https?:\/\//u, ""));
    const nature = page.locator('input[name="siteSeo.siteNature"]');
    if (await nature.count()) await nature.fill("自动化测试企业");
  }
}

async function dismissMaterialDialogs(page) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const text of ["确定", "我知道了"]) {
      const target = await firstVisible(page.getByText(text, { exact: true }));
      if (target) {
        await target.click({ force: true });
        await page.waitForTimeout(500);
      }
    }
    await page.waitForTimeout(500);
  }
}

async function userInspectThemeDialog(context, page, config, site) {
  await openMaterialsForSite(page, config, site, ["提交建站资料", "修改建站资料", "重新提交建站资料", "查看网站资料"]);
  await clickMaterialSection(page, 0);
  await dismissMaterialDialogs(page);
  const viewThemes = await firstVisible(page.getByText("查看主题", { exact: true }));
  if (!viewThemes) throw new Error("网站风格未找到“查看主题”入口");
  const popupPromise = context.waitForEvent("page", { timeout: 5_000 }).catch(() => null);
  await centerClick(viewThemes);
  const popup = await popupPromise;
  if (popup) await waitForSettled(popup, 1_500);
  await page.waitForTimeout(1_500);
  const current = popup || page;
  const snapshot = await current.evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return {
      status: "主题选择弹窗已打开（未选择）",
      controls: [...document.querySelectorAll("input, button, a, label")].filter(isVisible).map((item) => ({
        tag: item.tagName,
        id: item.id,
        name: item.getAttribute("name"),
        type: item.getAttribute("type"),
        text: item.textContent?.trim()?.slice(0, 200) || "",
        value: "value" in item ? String(item.value).slice(0, 200) : "",
        className: String(item.className || "").slice(0, 300),
      })).slice(0, 300),
      dialogs: [...document.querySelectorAll(".member-popup, .popup, .modal, [role='dialog']")]
        .filter(isVisible)
        .map((item) => item.outerHTML.slice(0, 30_000)),
      themeCards: [...document.querySelectorAll(".showlist-theme-preview")].slice(0, 3).map((item) => ({
        preview: item.outerHTML,
        parent: item.parentElement?.parentElement?.outerHTML?.slice(0, 12_000) || "",
      })),
    };
  });
  snapshot.pages = context.pages().map((item) => ({ url: item.url() }));
  return snapshot;
}

async function userInspectMaterialSection(context, page, config, site) {
  await openMaterialsForSite(page, config, site, ["提交建站资料", "修改建站资料", "重新提交建站资料", "查看网站资料"]);
  const sectionIndex = Number(site.inspectSection ?? 1);
  await clickMaterialSection(page, sectionIndex);
  await dismissMaterialDialogs(page);
  if (site.inspectUploadName) {
    const upload = page.locator(`a.uploadsimp-button:has(input[uploadname=${JSON.stringify(site.inspectUploadName)}])`);
    await upload.evaluate((element) => element.click());
    await page.waitForTimeout(5_000);
  }
  const snapshot = await page.evaluate((index) => ({
    status: `资料模块 ${index} 已打开（只读检查）`,
    inputs: [...document.querySelectorAll("input, textarea, select")].map((item) => ({
      tag: item.tagName,
      id: item.id,
      name: item.getAttribute("name"),
      type: item.getAttribute("type"),
      value: item.type === "password" ? "" : String(item.value || "").slice(0, 500),
      className: String(item.className || "").slice(0, 300),
      outerHTML: item.outerHTML.slice(0, 1_500),
    })),
    uploadAreas: [...document.querySelectorAll('[class*="upload" i], [id*="upload" i], [name*="annex" i], [name*="banner" i]')]
      .map((item) => item.outerHTML.slice(0, 8_000))
      .slice(0, 80),
  }), sectionIndex);
  snapshot.pages = context.pages().map((item) => item.url());
  snapshot.frames = await Promise.all(page.frames().map(async (frame) => ({
    url: frame.url(),
    fileInputs: await frame.locator('input[type="file"]').count().catch(() => -1),
    uploadStarts: await frame.locator("#uploadStart").count().catch(() => -1),
    visibleUploadStarts: await visible(frame.locator("#uploadStart")),
    bodyText: await frame.locator("body").innerText().then((text) => text.slice(0, 1_000)).catch(() => ""),
  })));
  return snapshot;
}

async function openMaterialsForSite(page, config, site, actionTexts = ["提交建站资料"]) {
  if (site.designComId) {
    const url = new URL("/customer-info.html", config.urls.cloudHome);
    url.searchParams.set("designComId", site.designComId);
    url.searchParams.set("designLanCode", site.languageCode || "0");
    await gotoPage(page, url.toString(), config);
    await waitForSettled(page, 2_000);
  } else {
    await gotoPage(page, config.urls.cloudHome, config);
    await waitForSettled(page, 2_000);
    await siteCardActionAny(page, config, site, actionTexts);
  }
  await dismissMaterialDialogs(page);
  if (!(await visible(page.locator("#customerInfoSubmitNew")))) {
    const rewrite = await firstVisible(page.locator("#reWriterCustomerInfo"))
      || await firstVisible(page.getByText("重新填写网站资料", { exact: true }));
    if (rewrite) {
      await rewrite.click({ force: true });
      await page.waitForTimeout(1_500);
      await dismissMaterialDialogs(page);
    }
  }
}

async function clickMaterialSaveAndNext(page) {
  const save = page.locator("#customerInfoSubmitNew:visible");
  await save.waitFor({ state: "visible", timeout: 15_000 });
  let saveResponse = null;
  for (let attempt = 0; attempt < 3 && !saveResponse; attempt += 1) {
    const saveResponsePromise = page.waitForResponse((response) => /\/customerInfo\/submit/u.test(response.url()), { timeout: 12_000 }).catch(() => null);
    await save.click({ force: true });
    saveResponse = await saveResponsePromise;
    if (!saveResponse) await page.waitForTimeout(5_000);
  }
  if (saveResponse) {
    if (!saveResponse.ok()) throw new Error(`资料保存请求失败：HTTP ${saveResponse.status()} ${saveResponse.url()}`);
    console.log(`[资料保存] HTTP ${saveResponse.status()} ${saveResponse.url()}`);
  }
  await page.waitForTimeout(2_200);
  const next = await firstVisible(page.getByText("下一步", { exact: true }));
  if (next) {
    await next.click({ force: true });
    await page.waitForTimeout(1_200);
  } else {
    const revise = await firstVisible(page.getByText("再改改", { exact: true }));
    if (revise) {
      await revise.click({ force: true });
      await page.waitForTimeout(1_200);
    }
  }
  return {
    saveRequest: saveResponse ? { url: saveResponse.url(), httpStatus: saveResponse.status() } : null,
  };
}

async function submitMaterialsForReview(page, site) {
  const sectionStates = await page.locator('a[onclick*="redirectLabel"]').evaluateAll((items) => items.map((item) => ({
    label: item.textContent?.trim() || "",
    icon: item.parentElement?.querySelector("i")?.className || "",
  })));
  const incomplete = sectionStates.filter((item) => !item.icon.includes("fa-check"));
  const bodyTextBeforeSubmit = await page.locator("body").innerText();
  const pageSaysComplete = /资料已完成.*提交审核/u.test(bodyTextBeforeSubmit);
  if (sectionStates.length && incomplete.length && !pageSaysComplete) {
    console.log(`[资料提交前校验] 侧栏仍显示未完成：${incomplete.map((item) => item.label).join("、")}；继续调用页面 check 接口确认`);
  }

  const submit = page.locator("#siteCheckSubmit");
  await submit.waitFor({ state: "attached", timeout: 15_000 });
  const checkResponsePromise = page.waitForResponse((response) => /\/customerInfo\/check/u.test(response.url()), { timeout: 20_000 });
  await submit.evaluate((element) => {
    element.scrollIntoView({ block: "center" });
    element.click();
  });
  const checkResponse = await checkResponsePromise;
  const checkBody = await checkResponse.text().catch(() => "");
  if (!checkResponse.ok() || checkBody.trim() !== "1") {
    throw new Error(`提交审核前校验失败：HTTP ${checkResponse.status()} ${checkBody}`);
  }
  await page.waitForTimeout(1_000);

  const confirmation = page.locator('.pui_dialog_btn[role="dialog_btn"]').filter({ hasText: "提交审核" });
  const confirmButton = await firstVisible(confirmation) || await firstVisible(page.getByText("提交审核", { exact: true }).last());
  if (!confirmButton) throw new Error("未找到二次确认弹窗中的“提交审核”按钮");
  const updateResponsePromise = page.waitForResponse((response) => /\/customerInfo\/updateProcess/u.test(response.url()), { timeout: 20_000 });
  await confirmButton.evaluate((element) => element.click());
  const updateResponse = await updateResponsePromise;
  const updateBody = await updateResponse.text().catch(() => "");
  if (!updateResponse.ok()) throw new Error(`提交资料审核失败：HTTP ${updateResponse.status()} ${updateBody.slice(0, 500)}`);
  await page.waitForTimeout(2_000);
  const bodyText = await page.locator("body").innerText();
  if (!/提交成功|等待.*审核/u.test(bodyText)) throw new Error(`${site.name} 提交资料后未出现成功提示`);
  return {
    status: "资料审核中",
    checkRequest: { url: checkResponse.url(), httpStatus: checkResponse.status(), responseBody: checkBody },
    submitRequest: { url: updateResponse.url(), httpStatus: updateResponse.status() },
  };
}

async function userSubmitMaterials(page, config, site) {
  await openMaterialsForSite(page, config, site, ["提交建站资料"]);

  const sectionLabels = site.materialSectionLabels || ["网站风格", "首页内容", "公司资料", "产品资料", "新闻资料", "其他页面资料", "联系资料", "网站优化"];
  for (let index = 0; index < sectionLabels.length; index += 1) {
    await clickMaterialSection(page, index);
    await fillKnownMaterialSection(page, site, index);
    const saveResult = await clickMaterialSaveAndNext(page);
    if (!saveResult.saveRequest) {
      console.log(`[资料保存] ${sectionLabels[index]} 未产生新的 customerInfo/submit 请求；页面已有内容，继续最终 check 校验`);
    }
    const sectionIcon = page.locator(`a[onclick*="redirectLabel('${index}')"]`).locator("xpath=..").locator("i");
    await page.waitForFunction((sectionIndex) => {
      const link = document.querySelector(`a[onclick*="redirectLabel('${sectionIndex}')"]`);
      return link?.parentElement?.querySelector("i")?.className.includes("fa-check");
    }, index, { timeout: 12_000 }).catch(() => undefined);
    const icon = await sectionIcon.getAttribute("class");
    const pageSaysComplete = /资料已完成.*提交审核/u.test(await page.locator("body").innerText());
    if (!icon?.includes("fa-check") && index !== sectionLabels.length - 1 && !pageSaysComplete) {
      console.log(`[资料侧栏提示] ${sectionLabels[index]} 保存请求成功，但完成图标未刷新；继续以最终 check 接口为准`);
    }
  }

  return submitMaterialsForReview(page, site);
}

async function modifyOneMaterialField(page, site) {
  const suffix = `-重新提交-${beijingTimestamp().replaceAll(/\D/gu, "").slice(-6)}`;
  const controls = page.locator('textarea:visible, input[type="text"]:visible, [contenteditable="true"]:visible');
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index);
    if (await control.isDisabled().catch(() => true)) continue;
    if (await control.getAttribute("readonly")) continue;
    const name = await control.getAttribute("name");
    const id = await control.getAttribute("id");
    if (name?.startsWith("extend") || id === "faptcha_response_field") continue;
    const tagName = await control.evaluate((element) => element.tagName);
    if (tagName === "INPUT" || tagName === "TEXTAREA") {
      const current = await control.inputValue().catch(() => "");
      await control.fill(`${current || site.formText}${suffix}`);
    } else {
      const current = await control.innerText().catch(() => "");
      await control.fill(`${current || site.formText}${suffix}`);
    }
    return true;
  }
  return false;
}

async function userResubmitMaterials(page, config, site) {
  await openMaterialsForSite(page, config, site, ["修改建站资料", "重新提交建站资料", "提交建站资料", "查看网站资料"]);
  // 拒绝后直接进入资料页时通常还停留在“网站风格”模块之外；显式打开一个可编辑模块。
  await clickMaterialSection(page, 0);
  await dismissMaterialDialogs(page);

  let changed = await modifyOneMaterialField(page, site);
  if (!changed) {
    const section = await firstVisible(page.locator(".fa-times, .icon-error, [class*='incomplete']"));
    if (section) {
      await centerClick(section);
      await page.waitForTimeout(500);
      changed = await modifyOneMaterialField(page, site);
    }
  }
  if (!changed) throw new Error("资料审核不通过后未找到可修改的资料字段");
  await clickMaterialSaveAndNext(page);
  const submission = await submitMaterialsForReview(page, site);
  return { ...submission, beforeStatus: "审核未通过", afterStatus: "资料审核中", modified: true };
}

async function openAdminDesignManagement(context, page, config) {
  await gotoPage(page, config.urls.cloudHome, config);
  await waitForSettled(page, 2_000);
  let agentPage = page;
  const serviceLink = await firstVisible(page.locator("a.contentShow-des-a.userEditSite").filter({ hasText: "服务商管理" }))
    || await firstVisible(page.getByText("服务商管理", { exact: true }));
  if (serviceLink) {
    const before = new Set(context.pages());
    await centerClick(serviceLink);
    await page.waitForTimeout(2_000);
    agentPage = context.pages().find((candidate) => !before.has(candidate)) || page;
  } else {
    await gotoPage(page, config.urls.agent, config);
    agentPage = page;
  }
  await waitForSettled(agentPage, 2_000);
  let scope = agentPage.frames().find((frame) => /\/agent(?:[/?#]|$)/u.test(frame.url())) || agentPage.mainFrame();
  const designManagement = await firstVisible(scope.getByText("设计管理", { exact: true }));
  if (designManagement) {
    await centerClick(designManagement);
    await agentPage.waitForTimeout(1_500);
    scope = agentPage.frames().find((frame) => /\/agent(?:[/?#]|$)/u.test(frame.url())) || agentPage.mainFrame();
  }
  return { page: agentPage, scope };
}

async function adminSearchSite(scope, site) {
  const search = scope.locator("#searchComName");
  await search.waitFor({ state: "visible", timeout: 20_000 });
  await search.fill(site.name);
  const query = await firstVisible(scope.locator('a.filterBtn[action="search_site_list"], [action="search_site_list"]'));
  if (query) await centerClick(query);
  else await search.press("Enter");
  await search.page().waitForTimeout(1_500);
  let row = scope.locator("tr").filter({ hasText: site.name });
  if (!(await row.count())) row = scope.locator("body").filter({ hasText: site.name });
  if (!(await row.count())) throw new Error(`管理员设计管理未找到：${site.name}`);
  return row.first();
}

function statusFromText(text) {
  return adminStatusCandidates.find((candidate) => text.includes(candidate)) || "未知";
}

async function adminRowSnapshot(row, site) {
  const text = (await row.innerText()).replaceAll(/\n{3,}/gu, "\n\n").trim();
  const websiteId = text.match(/网站ID[：:]\s*(\d+)/u)?.[1];
  const organizationId = text.match(/组织ID[：:]\s*(\d+)/u)?.[1];
  const companyId = text.match(/公司ID[：:]\s*(\d+)/u)?.[1];
  const dataId = await row.locator('input[name="dataId"]').first().getAttribute("value").catch(() => null);
  const previewHref = await row.locator('a[href*="customerInfo/preview"]').first().getAttribute("href").catch(() => null);
  let designComId = null;
  let designerId = null;
  if (previewHref) {
    const parsed = new URL(previewHref, "https://admin.example.invalid");
    designComId = parsed.searchParams.get("c");
    designerId = parsed.searchParams.get("d");
  }
  if (websiteId) site.siteSettingId = site.siteSettingId || websiteId;
  if (dataId) site.designId = site.designId || dataId;
  if (designComId) site.designComId = site.designComId || designComId;
  const actions = await row.locator("a, button").evaluateAll((items) => items.map((item) => ({
    text: item.textContent?.trim() || "",
    action: item.getAttribute("action"),
    href: item.getAttribute("href"),
    className: item.className,
  })).filter((item) => item.text || item.action));
  return {
    status: statusFromText(text),
    siteSettingId: websiteId || site.siteSettingId || null,
    organizationId: organizationId || null,
    companyId: companyId || null,
    designId: dataId || site.designId || null,
    designComId: designComId || site.designComId || null,
    designerId,
    actions,
    rowText: text,
  };
}

async function adminModal(scope) {
  const candidates = scope.locator('.member-popup:visible, .popup:visible, .modal:visible, [role="dialog"]:visible');
  return firstVisible(candidates);
}

async function fillFirstVisibleTextControl(scope, value) {
  const control = await firstVisible(scope.locator('textarea, input[type="text"]'));
  if (!control) return false;
  await control.fill(value);
  return true;
}

async function confirmVisibleDialog(scope) {
  for (const text of ["确定", "提交", "保存"]) {
    const button = await firstVisible(scope.getByText(text, { exact: true }));
    if (button) {
      await centerClick(button);
      return text;
    }
  }
  return null;
}

async function adminSetStatus(context, page, config, site, targetStatus, reason) {
  const admin = await openAdminDesignManagement(context, page, config);
  let row = await adminSearchSite(admin.scope, site);
  const before = await adminRowSnapshot(row, site);
  if (before.status === targetStatus) return { ...before, beforeStatus: before.status, afterStatus: before.status, unchanged: true };
  let setStatus = await firstVisible(row.getByText("设置状态", { exact: true }));
  let mode = "single";
  if (!setStatus) {
    const checkbox = row.locator('input[name="dataId"]');
    if (!(await checkbox.count())) throw new Error(`${site.name} 当前状态 ${before.status} 没有可选任务复选框，不能页面回退到 ${targetStatus}`);
    await checkbox.check({ force: true });
    setStatus = await firstVisible(admin.scope.locator('a[action="design_site_status_func"], button[action="design_site_status_func"]'));
    mode = "batch";
  }
  if (!setStatus) throw new Error(`${site.name} 当前状态 ${before.status} 没有可见“设置状态”入口，不能页面回退到 ${targetStatus}`);
  await centerClick(setStatus);
  await admin.page.waitForTimeout(600);
  const modal = await adminModal(admin.scope) || admin.scope;
  const select = await firstVisible(admin.scope.locator("#pop4statusStatus")) || await firstVisible(modal.locator("select"));
  if (!select) throw new Error("设置状态弹窗中未找到状态下拉框");
  const options = await select.locator("option").evaluateAll((items) => items.map((item) => ({ label: item.textContent?.trim(), value: item.value })));
  const option = options.find((item) => item.label === targetStatus || item.label?.includes(targetStatus));
  if (!option) throw new Error(`设置状态弹窗中没有“${targetStatus}”，可选项：${options.map((item) => item.label).filter(Boolean).join("、")}`);
  await select.selectOption(option.value);
  if (await select.inputValue() !== option.value) throw new Error(`状态下拉框未成功选中 ${targetStatus}`);
  const remark = await firstVisible(admin.scope.locator("#pop4statusRemark")) || await firstVisible(modal.locator("textarea"));
  if (remark) await remark.fill(reason);
  const saveStatus = await firstVisible(admin.scope.locator("#saveStatusSubmit"));
  let confirmed = null;
  const responsePromise = admin.page.waitForResponse((response) => /\/design\/site\/saveStatus(?:Batch)?/u.test(response.url()), { timeout: 20_000 }).catch(() => null);
  if (saveStatus) {
    await centerClick(saveStatus);
    confirmed = "确定";
  } else {
    confirmed = await confirmVisibleDialog(modal);
  }
  if (!confirmed) throw new Error("设置状态弹窗中未找到确定按钮");
  const response = await responsePromise;
  const responseBody = response ? await response.text().catch(() => "") : "";
  if (!response) throw new Error("点击设置状态确定后未发出 saveStatus 请求");
  await admin.page.waitForTimeout(2_000);
  row = await adminSearchSite(admin.scope, site);
  const after = await adminRowSnapshot(row, site);
  if (after.status !== targetStatus) {
    const responseIndex = responseBody.indexOf(site.name);
    const responseSnippet = responseIndex >= 0 ? responseBody.slice(Math.max(0, responseIndex - 300), responseIndex + 1_200) : responseBody.slice(0, 500);
    throw new Error(`页面设置状态后预期 ${targetStatus}，实际 ${after.status}；saveStatus HTTP ${response.status()} ${responseSnippet}`);
  }
  return { ...after, beforeStatus: before.status, afterStatus: after.status, setup: true, mode, request: { url: response.url(), httpStatus: response.status(), responseBody } };
}

async function adminInspectStatusDialog(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  const row = await adminSearchSite(admin.scope, site);
  const checkbox = row.locator('input[name="dataId"]');
  await checkbox.click({ force: true });
  const setStatus = await firstVisible(admin.scope.locator('a[action="design_site_status_func"]'));
  if (!setStatus) throw new Error("未找到顶部设置状态入口");
  await centerClick(setStatus);
  await admin.page.waitForTimeout(500);
  return admin.scope.locator("body").evaluate(() => {
    const jq = window.jQuery;
    const button = document.querySelector("#saveStatusSubmit");
    const events = button && jq && typeof jq._data === "function" ? jq._data(button, "events") : null;
    return {
      checked: [...document.querySelectorAll('input[name="dataId"]:checked')].map((item) => item.value),
      selectedStatus: document.querySelector("#pop4statusStatus")?.value,
      actualCost: document.querySelector("#actualCostStatus")?.value,
      sendNotice: [...document.querySelectorAll('input[type="checkbox"]')].filter((item) => item.getBoundingClientRect().width > 0).map((item) => ({ id: item.id, name: item.name, checked: item.checked, value: item.value })),
      submitHandler: events?.click?.map((item) => String(item.handler)) || [],
      popupHtml: button?.closest(".pop, .popup, .member-popup")?.outerHTML?.slice(0, 16000) || button?.parentElement?.parentElement?.outerHTML?.slice(0, 16000),
    };
  });
}

async function adminApproveMaterials(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  let row = await adminSearchSite(admin.scope, site);
  const before = await adminRowSnapshot(row, site);
  const pass = await firstVisible(row.getByText("审核通过", { exact: true }));
  const fallback = await firstVisible(row.locator('a[action="design_site_saveStatus"]'));
  const target = pass || fallback;
  if (!target) throw new Error(`${site.name} 当前没有“审核通过”操作，当前行：${(await row.innerText()).slice(0, 500)}`);
  await centerClick(target);
  await admin.page.waitForTimeout(1_500);
  row = await adminSearchSite(admin.scope, site);
  const after = await adminRowSnapshot(row, site);
  return { ...after, status: after.status, beforeStatus: before.status, afterStatus: after.status };
}

async function adminApproveDesign(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  let row = await adminSearchSite(admin.scope, site);
  const before = await adminRowSnapshot(row, site);
  if (!new Set(["设计审核中", "设计师审核中"]).has(before.status)) {
    throw new Error(`${site.name} 执行设计审核通过前必须为“设计审核中”，实际为“${before.status}”`);
  }
  const pass = await firstVisible(row.getByText("审核通过", { exact: true }));
  const fallback = await firstVisible(row.locator('a[action="design_site_saveStatus"]'));
  const target = pass || fallback;
  if (!target) throw new Error(`${site.name} 当前没有“审核通过”操作，当前行：${before.rowText.slice(0, 500)}`);
  const responsePromise = admin.page.waitForResponse((response) => response.request().method() === "POST" && /design|site/u.test(response.url()), { timeout: 20_000 }).catch(() => null);
  await centerClick(target);
  const response = await responsePromise;
  await admin.page.waitForTimeout(1_500);
  row = await adminSearchSite(admin.scope, site);
  const after = await adminRowSnapshot(row, site);
  if (after.status !== "用户审核中") {
    throw new Error(`设计审核通过后预期“用户审核中”，实际为“${after.status}”`);
  }
  return {
    ...after,
    beforeStatus: before.status,
    afterStatus: after.status,
    request: response ? { url: response.url(), httpStatus: response.status() } : null,
  };
}

async function adminRejectMaterials(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  let row = await adminSearchSite(admin.scope, site);
  const before = await adminRowSnapshot(row, site);
  if (before.status !== "资料审核中") throw new Error(`${site.name} 执行资料拒绝前必须为“资料审核中”，实际为“${before.status}”`);
  const reject = await firstVisible(row.getByText(/审核不通过|资料审核不通过/u));
  if (!reject) throw new Error(`${site.name} 当前行未找到“审核不通过”入口`);
  await centerClick(reject);
  await admin.page.waitForTimeout(800);
  const status = admin.scope.locator("#pop4statusStatus");
  await status.waitFor({ state: "visible", timeout: 10_000 });
  const selectedLabel = await status.locator("option:checked").innerText();
  if (!/资料审核未通过|审核不通过/u.test(selectedLabel)) {
    throw new Error(`资料审核不通过弹窗状态不正确：${selectedLabel}`);
  }
  const remark = admin.scope.locator("#pop4statusRemark");
  const reasonFieldAvailable = await visible(remark);
  if (reasonFieldAvailable) await remark.fill(site.materialRejectReason);
  const submit = admin.scope.locator("#saveStatusSubmit");
  await submit.waitFor({ state: "visible", timeout: 10_000 });
  const responsePromise = admin.page.waitForResponse((response) => /\/design\/site\/saveStatus/u.test(response.url()), { timeout: 20_000 });
  await centerClick(submit);
  const response = await responsePromise;
  const responseBody = await response.text().catch(() => "");
  if (!response.ok()) throw new Error(`资料审核不通过请求失败：HTTP ${response.status()} ${responseBody.slice(0, 500)}`);
  await admin.scope.locator("#popupLayerScreenLocker").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => undefined);
  await admin.page.waitForTimeout(1_500);
  row = await adminSearchSite(admin.scope, site);
  const after = await adminRowSnapshot(row, site);
  if (!/审核未通过|资料审核不通过/u.test(after.status) && !/审核未通过|资料审核不通过/u.test(after.rowText)) {
    throw new Error(`资料审核不通过后状态未生效，实际为“${after.status}”`);
  }
  return {
    ...after,
    status: after.status,
    beforeStatus: before.status,
    afterStatus: after.status,
    reason: reasonFieldAvailable ? site.materialRejectReason : null,
    reasonFieldAvailable,
    request: { url: response.url(), httpStatus: response.status(), responseBody },
  };
}

async function adminInspectMaterialReject(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  const row = await adminSearchSite(admin.scope, site);
  const reject = await firstVisible(row.getByText(/审核不通过|资料审核不通过/u));
  if (!reject) throw new Error(`${site.name} 当前行未找到“审核不通过”入口`);
  await centerClick(reject);
  await admin.page.waitForTimeout(1_000);
  return admin.scope.locator("body").evaluate(() => {
    const isVisible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const controls = [...document.querySelectorAll("input, textarea, select, a, button")]
      .filter(isVisible)
      .map((element) => ({
        tag: element.tagName,
        id: element.id,
        name: element.getAttribute("name"),
        type: element.getAttribute("type"),
        text: element.textContent?.trim() || "",
        value: element.value,
        action: element.getAttribute("action"),
        className: element.className,
      }))
      .filter((item) => /审核|通过|确定|取消|submit|remark|reason/u.test(JSON.stringify(item)));
    const lockers = [...document.querySelectorAll("#popupLayerScreenLocker, .member-popup, .popup, .pop, [role='dialog']")]
      .filter(isVisible)
      .map((element) => element.outerHTML.slice(0, 20_000));
    return { status: "拒绝弹窗已打开（未提交）", controls, lockers };
  });
}

async function adminAssignDesigner(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  const row = await adminSearchSite(admin.scope, site);
  const checkbox = row.locator('input[name="dataId"]');
  await checkbox.check({ force: true });
  const assign = await firstVisible(admin.scope.locator('a[action="allocate_designer_func"]'));
  if (!assign) throw new Error("未找到“分配设计师”操作");
  await centerClick(assign);
  await admin.page.waitForTimeout(800);
  const designerSearch = admin.scope.locator("#searchDesignerName");
  await designerSearch.click();
  await designerSearch.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await designerSearch.press("Backspace");
  await designerSearch.pressSequentially(site.designerName, { delay: 120 });
  await admin.page.waitForTimeout(1_800);
  const designerRow = admin.scope.locator("#popupLayer_pop4allocate tr").filter({ hasText: site.designerName }).first();
  if (!(await designerRow.count())) throw new Error(`未找到设计师：${site.designerName}`);
  await designerRow.locator('input[type="radio"]').check({ force: true });
  const responsePromise = admin.page.waitForResponse((response) => /\/design\/site\/doAllocate/u.test(response.url()), { timeout: 20_000 });
  await centerClick(admin.scope.locator("#doAllocateSubmit"));
  const response = await responsePromise;
  const responseBody = await response.text().catch(() => "");
  if (!response.ok()) throw new Error(`分配设计师请求失败：HTTP ${response.status()} ${responseBody.slice(0, 500)}`);
  await admin.page.waitForTimeout(1_500);
  const refreshedRow = await adminSearchSite(admin.scope, site);
  const after = await adminRowSnapshot(refreshedRow, site);
  if (after.status !== "已分配") throw new Error(`分配设计师后预期“已分配”，实际“${after.status}”`);
  return { ...after, status: "已分配", designer: site.designerName, request: { url: response.url(), httpStatus: response.status(), responseBody } };
}

async function adminInspectAssignDesigner(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  const row = await adminSearchSite(admin.scope, site);
  await row.locator('input[name="dataId"]').check({ force: true });
  const assign = await firstVisible(admin.scope.locator('a[action="allocate_designer_func"]'));
  if (!assign) throw new Error("未找到“分配设计师”操作");
  await centerClick(assign);
  await admin.page.waitForTimeout(1_200);
  return admin.scope.locator("body").evaluate(() => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    return {
      status: "分配设计师弹窗已打开（未提交）",
      allocationHtml: [...document.querySelectorAll('[id*="allocate" i], [class*="allocate" i]')]
        .map((element) => element.outerHTML)
        .join("\n")
        .slice(0, 30_000),
      designers: [...document.querySelectorAll('input[name="designerId"]')].filter(visible).map((input) => ({
        value: input.value,
        text: (input.closest("tr")?.textContent || input.parentElement?.textContent || "").replace(/\s+/gu, " ").trim(),
      })),
      controls: [...document.querySelectorAll("input, select, a, button")].filter(visible).map((element) => ({
        tag: element.tagName,
        id: element.id,
        name: element.getAttribute("name"),
        type: element.getAttribute("type"),
        text: element.textContent?.trim() || "",
        value: element.value,
        action: element.getAttribute("action"),
        className: element.className,
      })).filter((item) => /designer|设计师|搜索|查询|allocate|submit/u.test(JSON.stringify(item))),
    };
  });
}

async function openDesignerTasks(page, config, tabName) {
  await gotoPage(page, config.urls.taskList, config);
  await waitForSettled(page, 3_000);
  const tab = await firstVisible(page.locator('a[data-attr="filter"]').filter({ hasText: tabName }));
  if (tab) {
    await centerClick(tab);
    await page.waitForTimeout(1_800);
  }
}

async function targetTaskContainer(page, site) {
  if (site.designId) {
    const action = page.locator(`[data-id=${JSON.stringify(site.designId)}]`).first();
    await action.waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
    if (await action.count()) {
      const taskRow = action.locator("xpath=ancestor::tr[1]");
      if (await taskRow.count()) return taskRow;
    }
  }
  let row = page.locator("tr").filter({ hasText: site.name });
  if (await row.count()) return row.first();
  const title = await firstVisible(page.getByText(site.name, { exact: true }));
  if (!title) throw new Error(`设计任务未找到：${site.name}`);
  row = title.locator("xpath=ancestor::*[.//*[normalize-space()='编辑网站']][1]");
  return row;
}

async function designerStart(page, config, site) {
  await openDesignerTasks(page, config, "待设计");
  let edit;
  if (site.designId) {
    const actions = page.locator('a[data-attr="editSite"]');
    await actions.first().waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
    const ids = await actions.evaluateAll((items) => items.map((item) => item.getAttribute("data-id")));
    const index = ids.indexOf(site.designId);
    if (index >= 0) edit = actions.nth(index);
  }
  if (!edit) {
    const row = await targetTaskContainer(page, site);
    edit = row.getByText("编辑网站", { exact: true }).first();
  }
  await centerClick(edit);
  await page.waitForTimeout(800);
  const expectedTime = page.locator("#expectedTime");
  await expectedTime.waitFor({ state: "visible", timeout: 15_000 });
  const date = new Date();
  date.setDate(date.getDate() + Number(site.expectedCompletionDays || 7));
  const value = site.expectedCompletionDate || formatLocalDate(date);
  await expectedTime.evaluate((element, nextValue) => {
    element.removeAttribute("readonly");
    element.value = nextValue;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
  await centerClick(page.locator('a.member-popup-btn[data-attr="submit"]'));
  await page.waitForTimeout(2_000);
  return { status: "设计中", expectedCompletionDate: value };
}

async function designerSubmitReview(page, config, site) {
  page.once("dialog", async (dialog) => dialog.accept());
  await openDesignerTasks(page, config, "设计中");
  let submit;
  if (site.designId) {
    submit = page.locator(`a[data-attr="submitCheck"][data-id=${JSON.stringify(site.designId)}]`);
    await submit.waitFor({ state: "attached", timeout: 10_000 }).catch(() => undefined);
  }
  if (!submit || !(await submit.count())) {
    const row = await targetTaskContainer(page, site);
    submit = row.getByText("提交内审", { exact: true }).first();
  }
  await centerClick(submit);
  await page.waitForTimeout(2_000);
  return { status: "已提交内审；实际后续状态以服务商系统为准" };
}

async function userAccept(page, config, site) {
  if (site.designComId) {
    const url = new URL("/customer-info.html", config.urls.cloudHome);
    url.searchParams.set("designComId", site.designComId);
    url.searchParams.set("designLanCode", site.languageCode || "0");
    await gotoPage(page, url.toString(), config);
    await waitForSettled(page, 2_000);
  } else {
    await gotoPage(page, config.urls.cloudHome, config);
    await waitForSettled(page, 2_000);
    await siteCardAction(page, config, site, "验收您的网站");
  }

  const complete = page.locator(".siteCompleteNew");
  if (await visible(complete)) return { status: "用户通过", alreadyComplete: true };
  let checkbox;
  if (site.designId) checkbox = page.locator(`input.selectWebEachBtn[value=${JSON.stringify(site.designId)}]`);
  if (!checkbox || !(await checkbox.count())) checkbox = page.locator("input.selectWebEachBtn").first();
  await checkbox.evaluate((element) => element.scrollIntoView({ block: "center" }));
  if (!(await checkbox.isChecked())) await checkbox.click();
  const selected = await page.locator("#selectWebArray").getAttribute("value");
  if (!selected || selected === "[]") throw new Error("网站复选框已显示勾选，但页面内部选中列表为空");

  const pass = page.locator(".siteAcceptance .WebsiteTranslationBtn.okBtn");
  await centerClick(pass);
  await page.locator(".siteEvaluate").waitFor({ state: "visible", timeout: 10_000 });

  let item;
  if (site.designId) item = page.locator(`.siteEvaluate .eachWebItem[data-id=${JSON.stringify(site.designId)}]`);
  if (!item || !(await item.count())) item = page.locator(".siteEvaluate .eachWebItem:not(.totalSelect):visible").first();
  const groups = item.locator("ul.starsUl");
  for (let index = 0; index < await groups.count(); index += 1) {
    await centerClick(groups.nth(index).locator('li[data-index="4"]'));
  }
  await item.locator('textarea[name="suggest"]').fill(site.feedback);
  const label = await firstVisible(item.getByText("非常专业", { exact: true }));
  if (label) await centerClick(label);

  const responsePromise = page.waitForResponse((response) => /\/customerInfo\/verifyPass/u.test(response.url()), { timeout: 20_000 });
  await centerClick(page.locator(".siteEvaluate .WebsiteTranslationBtn.subBtn"));
  const response = await responsePromise;
  const body = await response.text();
  if (response.status() !== 200 || body.trim() !== "success") throw new Error(`用户验收提交失败：HTTP ${response.status()} ${body}`);
  await page.waitForTimeout(1_000);
  if (!(await visible(complete))) throw new Error("验收接口成功，但页面未进入“网站完成”");
  return {
    status: "用户通过",
    score: 5,
    request: { url: response.url(), httpStatus: response.status(), responseBody: body },
  };
}

async function openUserAcceptance(page, config, site) {
  if (site.designComId) {
    const url = new URL("/customer-info.html", config.urls.cloudHome);
    url.searchParams.set("designComId", site.designComId);
    url.searchParams.set("designLanCode", site.languageCode || "0");
    await gotoPage(page, url.toString(), config);
    await waitForSettled(page, 2_000);
  } else {
    await gotoPage(page, config.urls.cloudHome, config);
    await waitForSettled(page, 2_000);
    await siteCardAction(page, config, site, "验收您的网站");
  }
}

async function selectAcceptanceWebsite(page, site) {
  let checkbox;
  if (site.designId) checkbox = page.locator(`input.selectWebEachBtn[value=${JSON.stringify(site.designId)}]`);
  if (!checkbox || !(await checkbox.count())) checkbox = page.locator("input.selectWebEachBtn").first();
  if (!(await checkbox.count())) throw new Error("用户验收页面没有网站复选框");
  await checkbox.evaluate((element) => element.scrollIntoView({ block: "center" }));
  if (!(await checkbox.isChecked())) await checkbox.click();
  const selected = await page.locator("#selectWebArray").getAttribute("value");
  if (!selected || selected === "[]") throw new Error("网站复选框已显示勾选，但页面内部选中列表为空");
  return selected;
}

async function userReject(page, config, site) {
  await openUserAcceptance(page, config, site);
  if (!(await visible(page.locator(".siteAcceptance")))) throw new Error("当前用户页面不在“网站验收”状态");
  const selected = await selectAcceptanceWebsite(page, site);
  const rejectButton = page.locator(".siteAcceptance .WebsiteTranslationBtn.noBtn");
  if (!(await rejectButton.count())) throw new Error("网站验收页面未找到“不通过”按钮");
  await centerClick(rejectButton);
  const rejectSection = page.locator(".siteNopass");
  await rejectSection.waitFor({ state: "visible", timeout: 10_000 });

  let item;
  if (site.designId) item = rejectSection.locator(`.eachWebItem[data-id=${JSON.stringify(site.designId)}]`);
  if (!item || !(await item.count())) item = rejectSection.locator(".eachWebItem:not(.totalSelect):visible").first();
  if (!(await item.count())) item = rejectSection;

  const submitTexts = ["提交修改意见", "提交", "确定"];
  let submit = null;
  for (const text of submitTexts) {
    submit = await firstVisible(rejectSection.getByText(text, { exact: true }));
    if (submit) break;
  }
  if (!submit) throw new Error("验收不通过区域未找到“提交修改意见”按钮");

  const mutationRequests = [];
  const firstPartyOrigin = new URL(config.urls.cloudHome).origin;
  const requestListener = (request) => {
    let requestOrigin = "";
    try { requestOrigin = new URL(request.url()).origin; } catch { return; }
    if (request.method() === "POST" && requestOrigin === firstPartyOrigin && /customerInfo|design/u.test(request.url())) {
      mutationRequests.push(request.url());
    }
  };
  page.on("request", requestListener);
  await centerClick(submit);
  await page.waitForTimeout(1_200);
  const emptyValidationText = (await page.locator("body").innerText()).match(/请[^\n]{0,20}(?:意见|反馈|修改)[^\n]{0,20}/u)?.[0] || null;
  const emptyBlocked = await visible(rejectSection) && mutationRequests.length === 0;
  if (!emptyBlocked) {
    page.off("request", requestListener);
    throw new Error(`空意见提交未被正确拦截：区域可见=${await visible(rejectSection)}，POST=${mutationRequests.length}，请求=${mutationRequests.join(" | ")}`);
  }

  const opinion = await firstVisible(item.locator("textarea, input[type='text']")) || await firstVisible(rejectSection.locator("textarea, input[type='text']"));
  if (!opinion) {
    page.off("request", requestListener);
    throw new Error("验收不通过区域未找到修改意见输入框");
  }
  await opinion.fill(site.acceptanceRejectReason);
  const attachment = site.rejectAttachment || site.uploadFile;
  if (attachment) {
    await fs.access(attachment);
    const files = rejectSection.locator('input[type="file"]');
    if (await files.count()) await files.first().setInputFiles(attachment);
  }

  const responsePromise = page.waitForResponse((response) => response.request().method() === "POST" && /customerInfo|design/u.test(response.url()), { timeout: 20_000 });
  await centerClick(submit);
  const response = await responsePromise;
  const responseBody = await response.text().catch(() => "");
  page.off("request", requestListener);
  if (response.status() >= 400 || /fail|error/u.test(responseBody)) throw new Error(`验收不通过提交失败：HTTP ${response.status()} ${responseBody}`);
  await page.waitForTimeout(2_000);
  if (await visible(rejectSection)) throw new Error("验收不通过接口返回后页面仍停留在意见提交区域");
  return {
    status: "设计修改中",
    beforeStatus: "用户审核中",
    afterStatus: "设计修改中",
    selected,
    emptyValidation: { blocked: true, message: emptyValidationText, mutationRequests: 0 },
    validSubmission: { httpStatus: response.status(), responseBody, requestUrl: response.url(), attachment: Boolean(attachment) },
    reason: site.acceptanceRejectReason,
  };
}

async function designerVerifyModification(page, config, site) {
  const tabs = ["设计中", "待修改", "客户不通过", "待设计"];
  for (const tab of tabs) {
    await openDesignerTasks(page, config, tab);
    if (site.designId) {
      const task = page.locator(`[data-id=${JSON.stringify(site.designId)}]`).first();
      await task.waitFor({ state: "attached", timeout: 5_000 }).catch(() => undefined);
      if (await task.count()) return { status: "设计修改中", visibleInTab: tab, designId: site.designId };
    }
    if (await page.locator("tr").filter({ hasText: site.name }).count()) return { status: "设计修改中", visibleInTab: tab };
  }
  throw new Error(`${site.name} 验收不通过后未在设计师任务页找到待修改任务`);
}

async function adminStatus(context, page, config, site) {
  const admin = await openAdminDesignManagement(context, page, config);
  const row = await adminSearchSite(admin.scope, site);
  const snapshot = await adminRowSnapshot(row, site);
  snapshot.visibleToolbarActions = await admin.scope.locator("a:visible, button:visible").evaluateAll((items) => items.map((item) => ({
    text: item.textContent?.trim() || "",
    action: item.getAttribute("action"),
    className: item.className,
  })).filter((item) => item.text || item.action).slice(0, 120));
  return snapshot;
}

async function withRole(browser, config, role, operation) {
  const context = await browser.newContext({ locale: "zh-CN", viewport: { width: 1440, height: 900 }, ...(config.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}) });
  for (const hostname of config.environment?.deniedHostnames || []) {
    const escaped = hostname.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    await context.route(new RegExp(`^https?://${escaped}(?::\\d+)?(?:/|$)`, "iu"), (route) => route.abort("blockedbyclient"));
  }
  const page = await context.newPage();
  try {
    await login(page, config, credential(config, role));
    return await operation(context, page);
  } finally {
    await context.close();
  }
}

const actionRunners = {
  "user-submit-materials": { role: "user", run: (context, page, config, site) => userSubmitMaterials(page, config, site) },
  "user-inspect-theme-dialog": { role: "user", run: (context, page, config, site) => userInspectThemeDialog(context, page, config, site) },
  "user-inspect-material-section": { role: "user", run: (context, page, config, site) => userInspectMaterialSection(context, page, config, site) },
  "user-resubmit-materials": { role: "user", run: (context, page, config, site) => userResubmitMaterials(page, config, site) },
  "admin-approve-materials": { role: "admin", run: adminApproveMaterials },
  "admin-approve-design": { role: "admin", run: adminApproveDesign },
  "admin-reject-materials": { role: "admin", run: adminRejectMaterials },
  "admin-inspect-material-reject": { role: "admin", run: adminInspectMaterialReject },
  "admin-inspect-status-dialog": { role: "admin", run: adminInspectStatusDialog },
  "admin-prepare-material-review": { role: "admin", run: (context, page, config, site) => adminSetStatus(context, page, config, site, "资料审核中", "拒绝分支自动化前置状态准备") },
  "admin-assign-designer": { role: "admin", run: adminAssignDesigner },
  "admin-inspect-assign-designer": { role: "admin", run: adminInspectAssignDesigner },
  "designer-start": { role: "designer", run: (context, page, config, site) => designerStart(page, config, site) },
  "designer-submit-review": { role: "designer", run: (context, page, config, site) => designerSubmitReview(page, config, site) },
  "designer-verify-modification": { role: "designer", run: (context, page, config, site) => designerVerifyModification(page, config, site) },
  "user-accept": { role: "user", run: (context, page, config, site) => userAccept(page, config, site) },
  "user-reject": { role: "user", run: (context, page, config, site) => userReject(page, config, site) },
  "admin-status": { role: "admin", run: adminStatus },
};

async function runBatch(browser, config, action, sites, report) {
  const definition = actionRunners[action];
  if (!definition) throw new Error(`不支持动作：${action}`);
  return withRole(browser, config, definition.role, async (context, page) => {
    for (const site of sites) {
      const startedAt = new Date().toISOString();
      try {
        const result = await definition.run(context, page, config, site);
        const finishedAt = new Date().toISOString();
        report.events.push({
          site: site.name,
          siteSettingId: site.siteSettingId || result.siteSettingId || null,
          designId: site.designId || result.designId || null,
          designComId: site.designComId || result.designComId || null,
          action,
          role: definition.role,
          account: config.accounts?.[definition.role]?.account || null,
          startedAt,
          startedAtBeijing: beijingTimestamp(new Date(startedAt)),
          finishedAt,
          finishedAtBeijing: beijingTimestamp(new Date(finishedAt)),
          result,
        });
        console.log(`[成功] ${site.name} | ${action} | ${result.status || "完成"}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = new Date().toISOString();
        const failureStem = `failure-${timestampForFile()}-${action}-${site.siteSettingId || "unknown"}`;
        const screenshotPath = path.join(rootDir, "output", "playwright", `${failureStem}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        const pageDiagnostics = await page.evaluate(() => {
          const isVisible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
          };
          return {
            url: location.href,
            title: document.title,
            bodyText: document.body?.innerText?.slice(0, 5_000) || "",
            sections: [...document.querySelectorAll('a[onclick*="redirectLabel"]')].map((item) => ({
              text: item.textContent?.trim() || "",
              onclick: item.getAttribute("onclick"),
              parentHtml: item.parentElement?.outerHTML?.slice(0, 1_000) || "",
            })),
            controls: [...document.querySelectorAll("input, textarea, select, button, a")]
              .filter(isVisible)
              .map((item) => ({
                tag: item.tagName,
                id: item.id,
                name: item.getAttribute("name"),
                type: item.getAttribute("type"),
                text: item.textContent?.trim()?.slice(0, 200) || "",
                value: "value" in item && item.type !== "password" ? String(item.value).slice(0, 300) : "",
                className: String(item.className || "").slice(0, 300),
              }))
              .slice(0, 300),
            attachmentFields: [...document.querySelectorAll('input[type="hidden"][name]')]
              .filter((item) => /file|annex|material|logo|banner/u.test(item.name))
              .map((item) => ({ name: item.name, value: String(item.value || "").slice(0, 1_000) })),
            requiredFields: [...document.querySelectorAll(".required")].map((item) => ({
              name: item.getAttribute("name"),
              text: item.textContent?.replace(/\s+/gu, " ").trim().slice(0, 500) || "",
              html: item.outerHTML.slice(0, 3_000),
            })),
          };
        }).catch(() => null);
        report.events.push({
          site: site.name,
          siteSettingId: site.siteSettingId || null,
          designId: site.designId || null,
          designComId: site.designComId || null,
          action,
          role: definition.role,
          account: config.accounts?.[definition.role]?.account || null,
          startedAt,
          startedAtBeijing: beijingTimestamp(new Date(startedAt)),
          finishedAt,
          finishedAtBeijing: beijingTimestamp(new Date(finishedAt)),
          screenshotPath,
          pageDiagnostics,
          error: message,
        });
        console.error(`[失败] ${site.name} | ${action} | ${message}`);
        if (!config.continueOnError) throw error;
      }
    }
  });
}

async function runRejectBranchesFlow(browser, config, sites, report) {
  await runBatch(browser, config, "admin-status", sites, report);
  const preflight = report.events.at(-1)?.result;
  if (sites.length !== 1) throw new Error("reject-branches-flow 当前要求通过 --site 精确选择一条测试记录");
  if (preflight?.status === "资料未提交") {
    await runBatch(browser, config, "user-submit-materials", sites, report);
  } else if (preflight?.status !== "资料审核中") {
    await runBatch(browser, config, "admin-prepare-material-review", sites, report);
  }
  await runBatch(browser, config, "admin-reject-materials", sites, report);
  await runBatch(browser, config, "user-resubmit-materials", sites, report);
  await runBatch(browser, config, "admin-approve-materials", sites, report);
  await runBatch(browser, config, "admin-assign-designer", sites, report);
  await runBatch(browser, config, "designer-start", sites, report);
  await runBatch(browser, config, "designer-submit-review", sites, report);
  const beforeReject = await ensureUserReviewStatus(browser, config, sites, report);
  if (beforeReject !== "用户审核中") throw new Error(`用户验收不通过前预期“用户审核中”，实际“${beforeReject}”`);
  await runBatch(browser, config, "user-reject", sites, report);
  await runBatch(browser, config, "designer-verify-modification", sites, report);
  await runBatch(browser, config, "admin-status", sites, report);
  const finalStatus = report.events.at(-1)?.result?.status;
  if (!new Set(["用户不通过", "设计中", "审核未通过"]).has(finalStatus)) {
    throw new Error(`拒绝分支最终状态不是设计修改链路，实际“${finalStatus}”`);
  }
}

async function ensureUserReviewStatus(browser, config, sites, report) {
  await runBatch(browser, config, "admin-status", sites, report);
  let status = report.events.at(-1)?.result?.status;
  if (new Set(["设计审核中", "设计师审核中"]).has(status)) {
    await runBatch(browser, config, "admin-approve-design", sites, report);
    await runBatch(browser, config, "admin-status", sites, report);
    status = report.events.at(-1)?.result?.status;
  }
  if (status !== "用户审核中") {
    throw new Error(`设计提交后预期“用户审核中”或“设计审核中”，实际“${status}”`);
  }
  return status;
}

const args = parseArgs(process.argv.slice(2));
if (args.help || args.h) {
  showHelp();
  process.exit(0);
}

const action = args.action || "admin-status";
if (!supportedActions.includes(action)) {
  showHelp();
  throw new Error(`未知动作：${action}`);
}

const configPath = path.resolve(args.config || process.env.PHOENIX_FLOW_CONFIG || path.join(rootDir, "config", "design-flow.example.json"));
const rawConfig = await readJson(configPath);
const rawProxyPac = process.env.UI_PROXY_PAC ?? rawConfig.proxyPac;
const config = {
  ...rawConfig,
  proxy: process.env.UI_PROXY ?? rawConfig.proxy,
  proxyPac: rawProxyPac && !/^[a-z][a-z\d+.-]*:/iu.test(rawProxyPac)
    ? pathToFileURL(path.resolve(path.dirname(configPath), rawProxyPac)).href
    : rawProxyPac,
  urls: rawConfig.urls,
};
let sites = (config.sites || []).map((site) => mergeSite(config.defaults || {}, site));
if (args.site) sites = sites.filter((site) => site.name === args.site);
if (!sites.length) throw new Error(args.site ? `配置中不存在网站：${args.site}` : "配置中没有 sites");

const report = {
  action,
  configPath,
  startedAt: new Date().toISOString(),
  sites: sites.map((site) => ({ name: site.name, siteSettingId: site.siteSettingId, designId: site.designId })),
  events: [],
};

await fs.mkdir(path.join(rootDir, "output", "playwright"), { recursive: true });
let browser;
try {
  const launchArgs = [
    ...(config.proxyPac ? [`--proxy-pac-url=${config.proxyPac}`] : []),
    ...(config.ignoreHTTPSErrors ? ["--ignore-certificate-errors"] : []),
  ];
  browser = await chromium.launch({
    headless: Boolean(args.headless || process.env.HEADLESS === "1"),
    ...(launchArgs.length ? { args: launchArgs } : {}),
    ...(proxyOption(config.proxy) ? { proxy: proxyOption(config.proxy) } : {}),
  });
  if (action === "main-flow") {
    const beforeDesignReview = [
      "user-submit-materials",
      "admin-approve-materials",
      "admin-assign-designer",
      "designer-start",
      "designer-submit-review",
    ];
    for (const current of beforeDesignReview) await runBatch(browser, config, current, sites, report);
    await ensureUserReviewStatus(browser, config, sites, report);
    await runBatch(browser, config, "user-accept", sites, report);
    await runBatch(browser, config, "admin-status", sites, report);
  } else if (action === "reject-branches-flow") {
    await runRejectBranchesFlow(browser, config, sites, report);
  } else {
    await runBatch(browser, config, action, sites, report);
  }
} catch (error) {
  report.error = error instanceof Error ? error.stack || error.message : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await browser?.close();
  const reportPath = path.join(rootDir, "output", "playwright", `phoenix-design-flow-${timestampForFile()}.json`);
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(`运行报告：${reportPath}`);
}
