import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INTERESTING = /设置|管理\s*txt\s*文件|llms\.?txt|自定义\s*txt|保存|取消|开启|关闭/iu;

function unique(items) {
  return [...new Map(items.map((item) => [JSON.stringify(item), item])).values()];
}

async function collectFrame(frame) {
  const url = frame.url();
  const elements = await frame.locator("button, a, input, textarea, select, [role]").evaluateAll((nodes) => nodes.map((node) => ({
    tag: node.tagName.toLowerCase(),
    role: node.getAttribute("role"),
    text: (node.innerText || node.getAttribute("aria-label") || node.getAttribute("title") || "").trim().slice(0, 240),
    type: node.getAttribute("type"),
    name: node.getAttribute("name"),
    id: node.id || null,
    testId: node.getAttribute("data-testid"),
    placeholder: node.getAttribute("placeholder"),
    visible: Boolean(node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
  }))).catch(() => []);
  const visibleText = await frame.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  return {
    url,
    candidateElements: elements.filter((item) => item.visible && INTERESTING.test([item.text, item.placeholder, item.testId].filter(Boolean).join(" "))),
    testIds: unique(elements.filter((item) => item.visible && item.testId).map((item) => item.testId)),
    visibleTextSample: visibleText.slice(0, 4000)
  };
}

export async function probePage(page, config, options = {}) {
  const requests = [];
  const responses = [];
  const onRequest = (request) => {
    if (/\.js(?:\?|$)|\.css(?:\?|$)|\.png(?:\?|$)|\.jpg(?:\?|$)|\.svg(?:\?|$)/iu.test(request.url())) return;
    requests.push({ method: request.method(), url: request.url(), resourceType: request.resourceType() });
  };
  const onResponse = (response) => {
    if (/\.js(?:\?|$)|\.css(?:\?|$)|\.png(?:\?|$)|\.jpg(?:\?|$)|\.svg(?:\?|$)/iu.test(response.url())) return;
    responses.push({ status: response.status(), url: response.url(), resourceType: response.request().resourceType() });
  };
  // Attach listeners before any optional wait so late-loading app requests are retained.
  page.on("request", onRequest);
  page.on("response", onResponse);
  await mkdir(config.paths.artifactsDir, { recursive: true });
  await mkdir(path.dirname(config.paths.reportPath), { recursive: true });
  await mkdir(path.dirname(config.paths.htmlReportPath), { recursive: true });

  const frames = [];
  for (const frame of page.frames()) frames.push(await collectFrame(frame));
  await page.waitForTimeout(1000);
  for (const frame of page.frames()) {
    if (!frames.some((item) => item.url === frame.url())) frames.push(await collectFrame(frame));
  }
  const bodyText = frames.map((frame) => frame.visibleTextSample).join("\n");
  const testIds = unique(frames.flatMap((frame) => frame.testIds));
  const featureTextMatches = bodyText.match(/[^\n]*(?:设置|管理\s*txt\s*文件|llms\.?txt|自定义\s*txt|保存|开启|关闭)[^\n]*/giu) ?? [];
  const status = /管理\s*txt\s*文件|llms\.?txt/iu.test(bodyText) ? "feature-visible" : "feature-not-detected";
  const report = {
    generatedAt: new Date().toISOString(),
    status,
    interpretation: status === "feature-visible"
      ? "已在当前页面检测到 llms.txt 相关 UI 文本，请据此校准自动化定位器。"
      : "当前页面未检测到 llms.txt UI；可能尚未上线、尚未进入目标 3.0 编辑器或账号/站点不匹配。未生成虚假定位器。",
    page: { url: page.url(), title: await page.title().catch(() => "") },
    config: {
      loginUrl: config.loginUrl,
      proxyServer: config.proxy.server,
      siteName: config.siteName,
      siteLanguage: config.siteLanguage
    },
    frames,
    featureTextMatches: unique(featureTextMatches.map((text) => text.trim())).slice(0, 100),
    configuredTestIds: config.testIds,
    observedTestIds: testIds,
    network: {
      requests: unique(requests).slice(-200),
      responses: unique(responses).slice(-200)
    }
  };
  await page.screenshot({ path: path.join(config.paths.artifactsDir, "probe.png"), fullPage: false });
  await writeFile(path.join(config.paths.artifactsDir, "dom.html"), await page.content(), "utf8");
  await writeFile(config.paths.reportPath, JSON.stringify(report, null, 2), "utf8");
  await writeFile(config.paths.htmlReportPath, renderHtml(report), "utf8");
  page.off("request", onRequest);
  page.off("response", onResponse);
  return report;
}

function renderHtml(report) {
  const safe = JSON.stringify(report, null, 2).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<!doctype html><meta charset="utf-8"><title>llms.txt UI 探测报告</title><style>body{font:14px system-ui;max-width:1200px;margin:32px auto;padding:0 20px;background:#f7f7f8;color:#222}pre{white-space:pre-wrap;background:#fff;padding:20px;border-radius:10px;box-shadow:0 1px 4px #0002}.ok{color:#087f5b}.warn{color:#a15c00}</style><h1>llms.txt UI 探测报告</h1><p class="${report.status === "feature-visible" ? "ok" : "warn"}">${report.interpretation}</p><pre>${safe}</pre>`;
}
