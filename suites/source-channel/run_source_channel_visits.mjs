import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const DEFAULT_INPUT = path.join(ROOT, "来源渠道测试数据及预期结果.xlsx");
const DEFAULT_PROXY = "http://proxy.example.invalid:8080";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHEET_NAME = "测试数据与预期结果";
const HEADER_ROW = 4;
const FIRST_DATA_ROW = 5;
const DEFAULT_LAST_DATA_ROW = 259;
const HEADERS = ["用例ID", "qa_run", "qa_case", "测试套件", "测试场景", "目标URL", "URL参数", "Referrer", "本站域名", "预期来源渠道", "命中优先级", "预期命中规则", "测试目的", "数据来源", "是否探针", "是否核心用例", "执行状态", "实际渠道", "通过状态", "失败原因"];
const ANALYTICS_HOSTS = new Set(["ld-analytics.leadongcdn.com", "ld-analytics.sofastcdn.cn"]);

function shanghaiStamp() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}_${values.hour}${values.minute}${values.second}`;
}

function parseArgs(argv) {
  const stamp = shanghaiStamp();
  const options = {
    input: DEFAULT_INPUT,
    output: path.join(ROOT, `来源渠道测试数据及预期结果_探针执行结果_${stamp}.xlsx`),
    log: path.join(ROOT, `source_channel_probe_${stamp}.json`),
    preview: path.join(ROOT, `preview_probe_result_${stamp}.png`),
    proxy: DEFAULT_PROXY,
    noProxy: false,
    suite: "probe",
    limit: Infinity,
    waitMs: 10_000,
    timeoutMs: 60_000,
    concurrency: 1,
    headed: false,
    rerunCompleted: false,
    applyLog: "",
    checkpoint: path.join(ROOT, `source_channel_checkpoint_${stamp}.ndjson`),
    freshBrowserEachCase: false,
    maxAttempts: 1,
    caseIds: [],
    qaRetest: "",
    resumeCheckpoint: "",
    lastDataRow: DEFAULT_LAST_DATA_ROW,
    targetOrigin: "",
    siteDomain: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--input") options.input = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--log") options.log = argv[++index];
    else if (arg === "--preview") options.preview = argv[++index];
    else if (arg === "--proxy") {
      options.proxy = argv[++index];
      options.noProxy = false;
    }
    else if (arg === "--no-proxy") {
      options.noProxy = true;
      options.proxy = "";
    }
    else if (arg === "--suite") options.suite = argv[++index];
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--wait-ms") options.waitMs = Number(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--rerun-completed") options.rerunCompleted = true;
    else if (arg === "--apply-log") options.applyLog = argv[++index];
    else if (arg === "--checkpoint") options.checkpoint = argv[++index];
    else if (arg === "--fresh-browser-each-case") options.freshBrowserEachCase = true;
    else if (arg === "--max-attempts") options.maxAttempts = Number(argv[++index]);
    else if (arg === "--case-ids") options.caseIds = String(argv[++index] || "").split(",").map((item) => item.trim()).filter(Boolean);
    else if (arg === "--qa-retest") options.qaRetest = String(argv[++index] || "").trim();
    else if (arg === "--resume-checkpoint") options.resumeCheckpoint = String(argv[++index] || "").trim();
    else if (arg === "--last-data-row") options.lastDataRow = Number(argv[++index]);
    else if (arg === "--target-origin") options.targetOrigin = String(argv[++index] || "").trim();
    else if (arg === "--site-domain") options.siteDomain = String(argv[++index] || "").trim();
    else throw new Error(`未知参数：${arg}`);
  }
  if (!['probe', 'core', 'full'].includes(options.suite)) throw new Error(`不支持的suite：${options.suite}`);
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 5) throw new Error("concurrency必须为1~5的整数");
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5) throw new Error("max-attempts必须为1~5的整数");
  if (!Number.isInteger(options.lastDataRow) || options.lastDataRow < FIRST_DATA_ROW) throw new Error("last-data-row必须是不小于首行数据的整数");
  if (options.targetOrigin) {
    try { new URL(options.targetOrigin); } catch { throw new Error("target-origin必须是有效URL"); }
  }
  return options;
}

function hostOf(value) {
  if (!value) return "";
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function sameReferrer(expected, actual) {
  if (!expected) return !actual;
  return hostOf(expected) === hostOf(actual);
}

function selected(row, suite) {
  if (suite === "probe") return row.isProbe === "是";
  if (suite === "core") return row.isCore === "是";
  return true;
}

function appendRetestTag(targetUrl, qaRetest) {
  if (!qaRetest) return targetUrl;
  const url = new URL(targetUrl);
  url.searchParams.set("qa_retest", qaRetest);
  return url.toString();
}

function replaceOrigin(targetUrl, targetOrigin) {
  if (!targetOrigin) return targetUrl;
  const source = new URL(targetUrl);
  const destination = new URL(targetOrigin);
  source.protocol = destination.protocol;
  source.username = destination.username;
  source.password = destination.password;
  source.hostname = destination.hostname;
  source.port = destination.port;
  return source.toString();
}

function networkDescription(options) {
  return options.noProxy ? "正式环境直连（无代理）" : `代理${options.proxy}`;
}

async function loadCases(inputPath, suite, rerunCompleted, limit, caseIds = [], qaRetest = "", lastDataRow = DEFAULT_LAST_DATA_ROW, targetOrigin = "", siteDomainOverride = "") {
  const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
  const sheet = workbook.worksheets.getItem(SHEET_NAME);
  const values = sheet.getRange(`A${HEADER_ROW}:T${lastDataRow}`).values;
  const headers = values[0].map(String);
  if (headers.join("|") !== HEADERS.join("|")) throw new Error("测试工作簿表头与执行器预期不一致");
  const rows = values.slice(1).map((cells, index) => ({
    rowNumber: FIRST_DATA_ROW + index,
    caseId: String(cells[0] || ""),
    qaRun: String(cells[1] || ""),
    qaCase: String(cells[2] || ""),
    suite: String(cells[3] || ""),
    scenario: String(cells[4] || ""),
    targetUrl: String(cells[5] || ""),
    query: String(cells[6] || ""),
    referrer: String(cells[7] || ""),
    siteDomain: String(cells[8] || ""),
    expectedChannel: String(cells[9] || ""),
    expectedPriority: String(cells[10] || ""),
    expectedRule: String(cells[11] || ""),
    purpose: String(cells[12] || ""),
    source: String(cells[13] || ""),
    isProbe: String(cells[14] || ""),
    isCore: String(cells[15] || ""),
    executionStatus: String(cells[16] || ""),
  }));
  const chosen = rows
    .filter((row) => selected(row, suite))
    .filter((row) => caseIds.length === 0 || caseIds.includes(row.caseId))
    .filter((row) => rerunCompleted || row.executionStatus !== "已执行")
    .slice(0, Number.isFinite(limit) ? limit : rows.length)
    .map((row) => {
      const targetUrl = appendRetestTag(replaceOrigin(row.targetUrl, targetOrigin), qaRetest);
      return {
        ...row,
        targetUrl,
        query: new URL(targetUrl).search.slice(1),
        siteDomain: siteDomainOverride || row.siteDomain,
      };
    });
  return { workbook, sheet, rows: chosen };
}

function trackingEvidence(records, marker) {
  const dynamicTypes = new Set(["xhr", "fetch", "ping", "eventsource", "other"]);
  const successfulAll = records.filter((item) => item.status >= 200 && item.status < 400);
  const successful = records.filter((item) => dynamicTypes.has(item.resourceType) && item.status >= 200 && item.status < 400);
  const exactAnalytics = successfulAll.filter((item) => {
    try {
      const url = new URL(item.url);
      return ANALYTICS_HOSTS.has(url.hostname.toLowerCase()) && ["/collect", "/vs-collect"].includes(url.pathname);
    } catch {
      return false;
    }
  });
  const lowerMarker = String(marker).toLowerCase();
  const encodedMarker = encodeURIComponent(marker).toLowerCase();
  const markerMatches = successful.filter((item) => `${item.url}\n${item.postData || ""}`.toLowerCase().includes(lowerMarker) || `${item.url}\n${item.postData || ""}`.toLowerCase().includes(encodedMarker));
  const trackingRegex = /collect|track|visit|visitor|statistics|analytics|behavior|event|pixel|monitor|trace|pv|uv|utm|referer|referrer/i;
  const heuristic = successful.filter((item) => trackingRegex.test(`${item.url}\n${item.postData || ""}`));
  const candidates = exactAnalytics.length ? exactAnalytics : markerMatches.length ? markerMatches : heuristic;
  return { successful, exactAnalytics, markerMatches, heuristic, candidates };
}

async function executeCase(browser, row, options) {
  const startedAt = Date.now();
  const records = [];
  const requestMap = new Map();
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/proxy.example.invalid:8080 Safari/537.36",
      locale: "en-US",
      ignoreHTTPSErrors: true,
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4] });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    });
    const page = await context.newPage();
    page.on("request", (request) => {
      const record = {
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        postData: (request.postData() || "").slice(0, 4000),
        status: 0,
        failure: "",
      };
      records.push(record);
      requestMap.set(request, record);
    });
    page.on("response", (response) => {
      const record = requestMap.get(response.request());
      if (record) record.status = response.status();
    });
    page.on("requestfailed", (request) => {
      const record = requestMap.get(request);
      if (record) record.failure = request.failure()?.errorText || "request failed";
    });

    const gotoOptions = { waitUntil: "commit", timeout: options.timeoutMs };
    if (row.referrer) gotoOptions.referer = row.referrer;
    const response = await page.goto(row.targetUrl, gotoOptions);
    await page.waitForLoadState("domcontentloaded", { timeout: Math.min(options.timeoutMs, 30_000) }).catch(() => {});
    await page.waitForTimeout(options.waitMs);
    const pageState = await page.evaluate(() => ({
      finalUrl: location.href,
      title: document.title,
      referrer: document.referrer,
      bodyLength: document.body?.innerText?.length || 0,
      readyState: document.readyState,
    }));
    const httpStatus = response?.status() || 0;
    const referrerOk = sameReferrer(row.referrer, pageState.referrer);
    let finalParams = new URLSearchParams();
    try {
      finalParams = new URL(pageState.finalUrl).searchParams;
    } catch {
      // finalParams保持为空，下面的标识检查会失败并给出明确原因。
    }
    const qaCaseOk = finalParams.get("qa_case") === row.qaCase;
    const qaRunOk = finalParams.get("qa_run") === row.qaRun;
    const qaRetestOk = !options.qaRetest || finalParams.get("qa_retest") === options.qaRetest;
    const markerOk = qaCaseOk && qaRunOk && qaRetestOk;
    const evidence = trackingEvidence(records, row.qaCase);
    const pageOk = httpStatus >= 200 && httpStatus < 400 && pageState.bodyLength > 100;
    const beaconOk = evidence.exactAnalytics.length > 0;
    const success = pageOk && referrerOk && markerOk && beaconOk;
    const primaryEvidence = evidence.candidates[0];
    const reasonParts = [
      `页面HTTP ${httpStatus || "无响应"}`,
      `正文${pageState.bodyLength}字符`,
      referrerOk ? "Referrer符合" : `Referrer不符（实际：${pageState.referrer || "空"}）`,
      qaCaseOk ? "qa_case保留" : "qa_case丢失",
      qaRunOk ? "qa_run保留" : "qa_run丢失",
      qaRetestOk ? "qa_retest保留" : "qa_retest丢失",
      beaconOk ? `捕获Leadong统计上报${evidence.exactAnalytics.length}个` : `未识别Leadong统计上报（成功动态请求${evidence.successful.length}个）`,
    ];
    return {
      ...row,
      success,
      executionStatus: success ? "已执行" : "执行失败",
      passStatus: "待确认",
      reason: reasonParts.join("；"),
      httpStatus,
      elapsedMs: Date.now() - startedAt,
      pageState,
      requestCount: records.length,
      successfulDynamicCount: evidence.successful.length,
      markerMatchCount: evidence.markerMatches.length,
      heuristicMatchCount: evidence.heuristic.length,
      analyticsMatchCount: evidence.exactAnalytics.length,
      primaryEvidence: primaryEvidence ? { url: primaryEvidence.url, method: primaryEvidence.method, resourceType: primaryEvidence.resourceType, status: primaryEvidence.status, postData: primaryEvidence.postData } : null,
      dynamicRequests: records.filter((item) => ["xhr", "fetch", "ping", "eventsource", "other"].includes(item.resourceType)),
      analyticsRequests: evidence.exactAnalytics,
    };
  } catch (error) {
    return {
      ...row,
      success: false,
      executionStatus: "执行失败",
      passStatus: "待确认",
      reason: `浏览器执行失败：${error?.message || String(error)}`,
      elapsedMs: Date.now() - startedAt,
      dynamicRequests: records.filter((item) => ["xhr", "fetch", "ping", "eventsource", "other"].includes(item.resourceType)),
    };
  } finally {
    await context?.close().catch(() => {});
  }
}

async function executeWithConcurrency(browser, rows, options) {
  const results = new Array(rows.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= rows.length) return;
      const row = rows[index];
      console.log(`[${index + 1}/${rows.length}] ${row.caseId} ${row.scenario}`);
      results[index] = await executeCase(browser, row, options);
      await fs.appendFile(options.checkpoint, `${JSON.stringify(results[index])}\n`, "utf8");
      console.log(`  ${results[index].executionStatus}：${results[index].reason}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.concurrency, rows.length) }, () => worker()));
  return results;
}

async function executeWithFreshBrowsers(rows, options, launchOptions) {
  const results = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    console.log(`[${index + 1}/${rows.length}] ${row.caseId} ${row.scenario}`);
    let result;
    let attempt = 0;
    while (attempt < options.maxAttempts) {
      attempt += 1;
      const browser = await chromium.launch(launchOptions);
      try {
        result = await executeCase(browser, row, options);
      } finally {
        await browser.close().catch(() => {});
      }
      if (result.success) break;
      if (attempt < options.maxAttempts) console.log(`  第${attempt}次未成功，使用新浏览器重试`);
    }
    result.attemptCount = attempt;
    if (attempt > 1) result.reason = `共尝试${attempt}次；${result.reason}`;
    results.push(result);
    await fs.appendFile(options.checkpoint, `${JSON.stringify(result)}\n`, "utf8");
    console.log(`  ${result.executionStatus}：${result.reason}`);
  }
  return results;
}

async function executeSequentialWithRetries(rows, options, launchOptions) {
  const results = [];
  let browser = null;
  const closeBrowser = async () => {
    await browser?.close().catch(() => {});
    browser = null;
  };
  try {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      console.log(`[${index + 1}/${rows.length}] ${row.caseId} ${row.scenario}`);
      let result;
      let attempt = 0;
      while (attempt < options.maxAttempts) {
        attempt += 1;
        try {
          if (!browser) browser = await chromium.launch(launchOptions);
          result = await executeCase(browser, row, options);
        } catch (error) {
          result = {
            ...row,
            success: false,
            executionStatus: "执行失败",
            passStatus: "待确认",
            reason: `浏览器启动或执行失败：${error?.message || String(error)}`,
            dynamicRequests: [],
          };
        }
        if (result.success) break;
        await closeBrowser();
        if (attempt < options.maxAttempts) {
          console.log(`  第${attempt}次未成功，重启浏览器后重试`);
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
      }
      result.attemptCount = attempt;
      if (attempt > 1) result.reason = `共尝试${attempt}次；${result.reason}`;
      results.push(result);
      await fs.appendFile(options.checkpoint, `${JSON.stringify(result)}\n`, "utf8");
      console.log(`  ${result.executionStatus}：${result.reason}`);
    }
  } finally {
    await closeBrowser();
  }
  return results;
}

async function readCheckpoint(checkpointPath) {
  if (!checkpointPath) return [];
  const raw = await fs.readFile(checkpointPath, "utf8").catch(() => "");
  const latest = new Map();
  for (const line of raw.split(/\r?\n/).filter(Boolean)) {
    const result = JSON.parse(line);
    if (result.caseId) latest.set(result.caseId, result);
  }
  return [...latest.values()];
}

function colorResultRow(sheet, rowNumber, success) {
  sheet.getRange(`Q${rowNumber}`).format = {
    fill: success ? "#E2F0D9" : "#F4CCCC",
    font: { bold: true, color: success ? "#274E13" : "#990000", size: 9, name: "Microsoft YaHei" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  sheet.getRange(`S${rowNumber}`).format = {
    fill: "#FFF2CC",
    font: { bold: true, color: "#7F6000", size: 9, name: "Microsoft YaHei" },
    horizontalAlignment: "center",
    verticalAlignment: "center",
  };
  sheet.getRange(`T${rowNumber}`).format.fill = success ? "#EAF4E3" : "#FDEDEC";
}

function xmlSafe(value) {
  return String(value ?? "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
}

async function writeResults(loaded, results, options) {
  const { workbook, sheet } = loaded;
  const loadedByCase = new Map(loaded.rows.map((row) => [row.caseId, row]));
  const directTarget = options.targetOrigin || "";
  const directSiteDomain = options.siteDomain || "";
  const allCasesExecuted = results.length === 49 && results.every((result) => result.executionStatus === "已执行");
  for (const result of results) {
    const loadedRow = loadedByCase.get(result.caseId) || result;
    sheet.getRange(`F${result.rowNumber}:I${result.rowNumber}`).values = [[result.targetUrl || loadedRow.targetUrl, loadedRow.query, loadedRow.referrer, loadedRow.siteDomain]];
    sheet.getRange(`Q${result.rowNumber}:T${result.rowNumber}`).values = [[result.executionStatus, "", result.passStatus, xmlSafe(result.reason)]];
    colorResultRow(sheet, result.rowNumber, result.success);
  }
  const passed = results.filter((item) => item.success).length;
  const failed = results.length - passed;
  const detailSubtitle = `浏览器执行：${options.suite}；目标站点：${options.targetOrigin || "按工作簿"}；网络方式：${networkDescription(options)}；本次${results.length}条，已制造${passed}条，失败${failed}条。实际渠道需在智慧数据侧核对。`;
  sheet.getRange("A2:T2").values = [Array(20).fill(detailSubtitle)];
  sheet.getRange("A2:T2").format = {
    fill: failed ? "#FCE4D6" : "#E2F0D9",
    font: { color: failed ? "#9C0006" : "#274E13", size: 10, name: "Microsoft YaHei" },
    verticalAlignment: "center",
    wrapText: true,
    borders: { bottom: { style: "thin", color: "#D9E2F3" } },
  };

  const overview = workbook.worksheets.getItem("统计概览");
  const overviewSubtitle = `目标：${directTarget || "按工作簿"}｜专项${results.length}条｜批次：${options.qaRetest || "按工作簿"}｜网络方式：${networkDescription(options)}；认证信息不入表。`;
  overview.getRange("A2:H2").values = [Array(8).fill(overviewSubtitle)];
  overview.getRange("A6:H6").values = [["目标域名", directSiteDomain || "按工作簿", "网络方式", options.noProxy ? "正式环境直连" : "代理访问", "代理服务器", options.noProxy ? "不使用" : options.proxy, "执行状态", allCasesExecuted ? "已执行" : "部分执行"]];
  overview.getRange("A26:H26").values = [Array(8).fill(options.noProxy ? "本次访问使用正式站直连，不设置代理；每条独立浏览器上下文；捕获Leadong /collect或/vs-collect；代理认证信息不适用。" : `本次访问使用${options.proxy}；代理认证信息不入表。`)];
  if (allCasesExecuted) overview.getRange("D18:D22").values = [["已执行"], ["已执行"], ["已执行"], ["已执行"], ["已执行"]];

  const ruleSheet = workbook.worksheets.getItem("规则说明");
  ruleSheet.getRange("A26:E26").values = [["B7", "网络方式", options.noProxy ? "本次执行使用正式站直连，不设置代理" : `本次执行使用${options.proxy}`, options.noProxy ? "禁止代理回退；认证信息不入表" : "代理认证信息必须脱敏", "全部用例"]];

  await fs.mkdir(path.dirname(options.output), { recursive: true });
  const exported = await SpreadsheetFile.exportXlsx(workbook);
  await exported.save(options.output);
  const finalBook = await SpreadsheetFile.importXlsx(await FileBlob.load(options.output));
  const errors = await finalBook.inspect({ kind: "match", searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A", options: { useRegex: true, maxResults: 300 }, summary: "execution result formula error scan" });
  if (errors.ndjson.trim() && !errors.ndjson.includes("Cell search matched 0 entries.")) throw new Error(`执行结果工作簿存在公式错误：${errors.ndjson}`);
  const preview = await finalBook.render({ sheetName: SHEET_NAME, range: "K1:T14", scale: 1, format: "png" });
  await fs.writeFile(options.preview, new Uint8Array(await preview.arrayBuffer()));
  return { passed, failed };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const loaded = await loadCases(options.input, options.suite, options.rerunCompleted, options.limit, options.caseIds, options.qaRetest, options.lastDataRow, options.targetOrigin, options.siteDomain);
  const selectedRows = [...loaded.rows];
  if (options.applyLog) {
    const raw = await fs.readFile(options.applyLog, "utf8");
    const results = options.applyLog.endsWith(".ndjson")
      ? raw.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
      : JSON.parse(raw).results || [];
    if (!results.length) throw new Error("日志中没有可写回的执行结果");
    const summary = await writeResults(loaded, results, options);
    console.log(JSON.stringify({ output: options.output, log: options.applyLog, preview: options.preview, recovered: true, total: results.length, ...summary }, null, 2));
    return;
  }
  if (selectedRows.length === 0) throw new Error("没有符合条件且需要执行的用例");
  const priorResults = await readCheckpoint(options.resumeCheckpoint);
  const priorByCase = new Map(priorResults.map((result) => [result.caseId, result]));
  loaded.rows = selectedRows.filter((row) => !priorByCase.get(row.caseId)?.success);
  if (priorResults.length) {
    console.log(`读取断点${priorResults.length}条，其中成功${priorResults.filter((item) => item.success).length}条；本次继续执行${loaded.rows.length}条`);
  }
  console.log(`准备执行${loaded.rows.length}条${options.suite}用例，网络方式：${networkDescription(options)}`);
  if (options.noProxy) {
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
  }
  const launchOptions = {
    headless: !options.headed,
    executablePath: CHROME,
    timeout: 60_000,
  };
  if (options.noProxy) launchOptions.args = ["--no-proxy-server"];
  else {
    const username = process.env.QA_PROXY_USERNAME || "";
    const password = process.env.QA_PROXY_PASSWORD || "";
    launchOptions.proxy = { server: options.proxy };
    if (username || password) {
      launchOptions.proxy.username = username;
      launchOptions.proxy.password = password;
    }
  }
  if (!options.resumeCheckpoint) await fs.writeFile(options.checkpoint, "", "utf8");
  let newResults;
  if (options.freshBrowserEachCase) {
    newResults = await executeWithFreshBrowsers(loaded.rows, options, launchOptions);
  } else if (options.concurrency === 1 && options.maxAttempts > 1) {
    newResults = await executeSequentialWithRetries(loaded.rows, options, launchOptions);
  } else {
    const browser = await chromium.launch(launchOptions);
    try {
      newResults = await executeWithConcurrency(browser, loaded.rows, options);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  const combinedByCase = new Map(priorResults.map((result) => [result.caseId, result]));
  for (const result of newResults) combinedByCase.set(result.caseId, result);
  const results = selectedRows.map((row) => combinedByCase.get(row.caseId)).filter(Boolean);
  if (results.length !== selectedRows.length) throw new Error(`断点续跑结果不完整：应有${selectedRows.length}条，实际${results.length}条`);
  await fs.writeFile(options.log, `${JSON.stringify({ generatedAt: new Date().toISOString(), options: { ...options, input: path.basename(options.input), output: path.basename(options.output), log: path.basename(options.log), preview: path.basename(options.preview) }, results }, null, 2)}\n`, "utf8");
  const summary = await writeResults(loaded, results, options);
  console.log(JSON.stringify({ output: options.output, log: options.log, preview: options.preview, total: results.length, ...summary }, null, 2));
  if (summary.failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
