import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const targetUrl = process.env.GRAY_TARGET_URL || "http://www.leadong.com/website.html";
const pacPath = path.resolve(process.env.GRAY_PAC_PATH || path.join(rootDir, "config", "gray.pac"));
const outputDir = path.join(rootDir, "output", "playwright");
const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
const screenshotPath = path.join(outputDir, `gray-environment-${timestamp}.png`);
const reportPath = path.join(outputDir, `gray-environment-${timestamp}.json`);

await fs.mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({
  headless: process.env.HEADLESS === "1",
  args: [
    `--proxy-pac-url=${pathToFileURL(pacPath).href}`,
    "--ignore-certificate-errors",
  ],
});

const context = await browser.newContext({
  locale: "zh-CN",
  viewport: { width: 1440, height: 900 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
const documentResponses = [];

page.on("response", async (response) => {
  const request = response.request();
  if (request.resourceType() !== "document") return;
  const headers = await response.allHeaders().catch(() => ({}));
  documentResponses.push({
    url: response.url(),
    status: response.status(),
    headers: {
      location: headers.location || null,
      server: headers.server || null,
      via: headers.via || null,
      xVia: headers["x-via"] || null,
      phoenixMark: headers["phoenix-mark"] || null,
      phoenixTid: headers["phoenix-t-id"] || null,
    },
  });
});

let navigationError = null;
let loginAttempted = false;
let afterLoginUrl = null;
let authenticatedRevisit = null;
let serviceInspection = null;
try {
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(5_000);
  const account = process.env.GRAY_LOGIN_ACCOUNT;
  const password = process.env.GRAY_LOGIN_PASSWORD;
  if (account && password && await page.locator("#loginName").isVisible().catch(() => false)) {
    loginAttempted = true;
    await page.locator("#loginName").fill(account);
    await page.locator("#password").fill(password);
    await page.locator("#loginSubmit").click();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(4_000);
    afterLoginUrl = page.url();

    const responseStart = documentResponses.length;
    const revisitResponse = await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(4_000);
    authenticatedRevisit = {
      responseStatus: revisitResponse?.status() || null,
      finalUrl: page.url(),
      documentResponses: documentResponses.slice(responseStart),
    };
    if (process.env.GRAY_INSPECT_SERVICE === "1") {
      const serviceCard = page.locator("a.contentShow-des-a.userEditSite").filter({ hasText: "服务商管理" }).first();
      if (await serviceCard.isVisible().catch(() => false)) {
        const card = await serviceCard.evaluate((element) => ({
          outerHTML: element.outerHTML.slice(0, 8_000),
          dataset: { ...element.dataset },
        }));
        const before = new Set(context.pages());
        const popupPromise = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);
        await serviceCard.click();
        const popup = await popupPromise;
        const servicePage = popup || context.pages().find((candidate) => !before.has(candidate)) || page;
        await servicePage.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
        await servicePage.waitForTimeout(3_000);
        serviceInspection = {
          card,
          url: servicePage.url(),
          title: await servicePage.title().catch(() => ""),
          bodyText: (await servicePage.locator("body").innerText().catch(() => "")).slice(0, 2_000),
        };
      }
    }
  }
} catch (error) {
  navigationError = error instanceof Error ? error.message : String(error);
}

await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

const finalUrl = page.url();
const final = new URL(finalUrl);
const firstDocumentResponse = documentResponses[0] || null;
const grayEvidence = documentResponses.some((entry) => {
  const value = `${entry.headers.xVia || ""} ${entry.headers.via || ""}`;
  return /gray|Ld-Gray/iu.test(value);
});
const report = {
  targetUrl,
  pacSourceUrl: "http://proxy.example.invalid:8080/gray.pac",
  pacFile: pacPath,
  startedWithHttp: targetUrl.startsWith("http://"),
  serverRedirectedToHttps: firstDocumentResponse?.status === 301
    && firstDocumentResponse?.headers.location?.startsWith("https://www.leadong.com/") === true,
  finalUrl,
  finalProtocol: final.protocol,
  finalHostname: final.hostname,
  title: await page.title().catch(() => ""),
  serviceManagementLinks: await page.locator("a").evaluateAll((items) => items
    .filter((item) => item.textContent?.trim() === "服务商管理")
    .map((item) => ({ href: item.href, target: item.target, onclick: item.getAttribute("onclick"), className: item.className }))),
  loginAttempted,
  afterLoginUrl,
  authenticatedRevisit,
  serviceInspection,
  grayEvidence,
  navigationError,
  documentResponses,
  screenshotPath,
};

await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await context.close();
await browser.close();

console.log(JSON.stringify({ ...report, reportPath }, null, 2));
if (navigationError || !report.startedWithHttp || !grayEvidence || final.hostname !== "www.leadong.com") {
  process.exitCode = 1;
}
