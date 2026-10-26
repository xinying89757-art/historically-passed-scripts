import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runnerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [fullRunId, retryRunId, outputDirectory] = process.argv.slice(2);
if (![fullRunId, retryRunId].every((id) => /^BUG1004949-[0-9]{17}$/u.test(id)) || !outputDirectory) {
  throw new Error("Usage: npm run report:combine -- <full-run-id> <retry-run-id> <output-directory>");
}

const retryIds = new Set([
  "用例-0028", "用例-0029", "用例-0030", "用例-0031", "用例-0032",
  "用例-0033", "用例-0035", "用例-0036", "用例-0038",
]);
const runFile = (id, name) => path.join(runnerRoot, "results", "runs", id, name);
const [full, retry, fullRecovery, retryRecovery] = await Promise.all([
  fs.readFile(runFile(fullRunId, "ui-execution-results.v3.json"), "utf8").then(JSON.parse),
  fs.readFile(runFile(retryRunId, "ui-execution-results.v3.json"), "utf8").then(JSON.parse),
  fs.readFile(runFile(fullRunId, "recovery-status.json"), "utf8").then(JSON.parse),
  fs.readFile(runFile(retryRunId, "recovery-status.json"), "utf8").then(JSON.parse),
]);
if (fullRecovery.status !== "passed" || retryRecovery.status !== "passed") {
  throw new Error("Both runs must have verified backend recovery before results can be combined");
}
const byFullId = new Map(full.cases.map((row) => [row.case_id, row]));
const byRetryId = new Map(retry.cases.map((row) => [row.case_id, row]));
if (byFullId.size !== 40 || full.cases.length !== 40) throw new Error("Full run must contain 40 unique cases");
for (const id of retryIds) {
  if (byFullId.get(id)?.status !== "automation_failure" || byRetryId.get(id)?.status !== "passed" || !byRetryId.get(id)?.attempted) {
    throw new Error(`Retry result does not resolve the full-run automation failure: ${id}`);
  }
}
if (retry.cases.filter((row) => row.attempted).length !== retryIds.size) {
  throw new Error("Retry run includes unexpected executed cases");
}

const retryReasons = {
  "用例-0028": "已保存产品自定义 URL，并确认前台产品标题和内容正确。",
  "用例-0029": "已分别保存三篇文章的自定义 URL，并确认前台标题和正文对应正确。",
  "用例-0030": "已保存产品分类自定义 URL，并确认分类列表与分页可访问。",
  "用例-0031": "已保存文章分类自定义 URL，并确认分类列表与分页可访问。",
  "用例-0032": "已保存图册详情自定义 URL，并确认前台图册内容正确。",
  "用例-0033": "已保存图册分类自定义 URL，并确认前台分类内容正确。",
  "用例-0035": "已保存视频分类自定义 URL，并确认前台分类内容正确。",
  "用例-0036": "已先后设置带目录和根目录产品 URL，两种地址均能访问对应产品。",
  "用例-0038": "已验证带目录的产品、文章分类分页，再改为根目录 URL 验证分页。",
};

const rows = full.cases.map((original) => {
  const retried = retryIds.has(original.case_id);
  const row = retried ? byRetryId.get(original.case_id) : original;
  return {
    ...row,
    source_run_id: retried ? retryRunId : fullRunId,
    reason: retried ? retryReasons[row.case_id]
      : row.status === "passed" ? "脚本已按用例步骤完成验证，页面表现符合预期。" : row.reason,
  };
});
const summary = {
  total: rows.length,
  attempted: rows.filter((row) => row.attempted).length,
  passed: rows.filter((row) => row.status === "passed").length,
  business_failure: rows.filter((row) => row.status === "business_failure").length,
  automation_failure: rows.filter((row) => row.status === "automation_failure").length,
  environment_blocked: rows.filter((row) => row.status === "environment_blocked").length,
  product_confirmation: rows.filter((row) => row.status === "product_confirmation").length,
};
if (summary.attempted !== 36 || summary.automation_failure !== 0 || summary.environment_blocked !== 3 || summary.product_confirmation !== 1 || summary.passed + summary.business_failure !== 36) {
  throw new Error(`Unexpected combined summary: ${JSON.stringify(summary)}`);
}

const outputDir = path.resolve(outputDirectory);
await fs.mkdir(outputDir, { recursive: true });
const result = {
  schema_version: "ui-execution-results.v3",
  run_id: `${fullRunId}+${retryRunId}`,
  source_runs: [fullRunId, retryRunId],
  project_id: "bug1004949-en-site",
  finished_at: new Date().toISOString(),
  cases: rows,
  summary,
};
await fs.writeFile(path.join(outputDir, "ui-execution-results.v3.json"), JSON.stringify(result, null, 2), "utf8");
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const statusText = {
  business_failure: "不通过", environment_blocked: "环境阻塞", product_confirmation: "待产品确认",
};
const exceptionRows = rows.filter((row) => row.status !== "passed").map((row) =>
  `<tr><td>${escapeHtml(row.case_id)}</td><td>${escapeHtml(statusText[row.status] ?? row.status)}</td><td>${escapeHtml(row.reason)}</td></tr>`).join("\n");
const report = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BUG1004949 UI 自动化测试报告</title>
<style>body{font:16px/1.65 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;color:#213044;background:#f5f7fa;margin:0}main{max-width:1000px;margin:32px auto;padding:36px;background:#fff;border-radius:12px;box-shadow:0 8px 28px #14243b12}h1{font-size:26px;margin:0 0 6px}h2{font-size:19px;margin:30px 0 10px;border-bottom:1px solid #e2e8f0;padding-bottom:7px}.meta{color:#627186}.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin:22px 0}.stat{background:#f1f5f9;padding:14px;border-radius:8px}.stat strong{display:block;font-size:24px;color:#164a78}.stat span{font-size:13px;color:#536579}table{width:100%;border-collapse:collapse}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #e2e8f0;padding:10px}th{background:#edf3f8}td:first-child{white-space:nowrap}a{color:#006eb9}p,li{max-width:90ch}small{color:#627186}@media(max-width:650px){main{margin:0;padding:18px;border-radius:0}.stats{grid-template-columns:repeat(2,1fr)}table{font-size:14px}}</style>
<main><h1>BUG1004949 UI 自动化测试报告</h1><div class="meta">英语站点：${escapeHtml("http://site.example.invalid")}　｜　2026-09-17　｜　无代理、有界面 Chromium</div>
<div class="stats"><div class="stat"><strong>50</strong><span>完整用例</span></div><div class="stat"><strong>${summary.passed}</strong><span>自动化通过</span></div><div class="stat"><strong>${summary.business_failure}</strong><span>业务不通过</span></div><div class="stat"><strong>${summary.environment_blocked} + ${summary.product_confirmation}</strong><span>环境阻塞 / 待产品确认</span></div><div class="stat"><strong>10</strong><span>人工测试</span></div></div>
<h2>执行结论</h2><p>36 条可运行用例已执行：${summary.passed} 条通过、${summary.business_failure} 条业务不通过、0 条自动化失败。另有 3 条环境阻塞、1 条待产品确认；完整用例表中其余 10 条保持人工测试。两次运行结束后，后台权限和自定义 URL 的恢复检查均通过。</p>
<p>本结果由一次完整运行和一次定向补跑组成。完整运行在配置文章 <code>article three</code> 时发现页面异步刷新使新 URL 未进入保存请求，自定义 URL 组的 9 条用例当时未进入前台验证。修复保存前校验并补跑该组后，9 条均通过。此汇总不表示 36 条在同一轮连续运行中全部通过。</p>
<h2>未通过与未自动执行的用例</h2><table><thead><tr><th>用例</th><th>状态</th><th>原因</th></tr></thead><tbody>${exceptionRows}</tbody></table>
<h2>环境与结果范围</h2><p>后台入口：${escapeHtml("https://admin.example.invalid/website.html")}；前台为上述英语站点。管理员场景配置串行执行，前台只读验证按套件配置执行；员工账号通过领动云平台登录，会员账号通过前台登录。遇到“多站点登录”时，脚本依次点击“继续登录”和“确定”。</p>
<p>完整运行编号：<code>${escapeHtml(fullRunId)}</code><br>自定义 URL 补跑编号：<code>${escapeHtml(retryRunId)}</code></p>
<p><a href="./BUG1004949-执行结果-合并.xlsx">下载完整 50 条用例 Excel（含状态和原因）</a></p><small>报告中的通过状态来自实际前台断言；人工测试用例未纳入自动化通过率。</small></main></html>`;
await fs.writeFile(path.join(outputDir, "BUG1004949-测试报告.html"), report, "utf8");

const workbookPath = path.join(outputDir, "BUG1004949-执行结果-合并.xlsx");
const inputPath = path.join(outputDir, ".combined-rows.json");
await fs.writeFile(inputPath, JSON.stringify(rows), "utf8");
try {
  const runtimeNode = process.env.UI_ARTIFACT_NODE ?? process.execPath;
  const writer = path.join(runnerRoot, "support", "artifact-runtime", "write-full-results-xlsx.mjs");
  const source = process.env.UI_FULL_CASE_SOURCE_XLSX ?? path.resolve(runnerRoot, "../../../../outputs/BUG1004949-final-20260915-r4/BUG1004949-测试用例-全-自动化结果.xlsx");
  await new Promise((resolve, reject) => {
    const child = spawn(runtimeNode, [writer, inputPath, source, workbookPath], { cwd: runnerRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`Workbook writer exited with ${code ?? 1}`)));
  });
} finally {
  await fs.rm(inputPath, { force: true });
}
console.log(JSON.stringify({ summary, workbookPath }, null, 2));
