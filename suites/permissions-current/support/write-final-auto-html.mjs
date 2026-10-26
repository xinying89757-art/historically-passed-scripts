import fs from "node:fs/promises";
import path from "node:path";

const [resultsPath, outputPath] = process.argv.slice(2);
if (!resultsPath || !outputPath) throw new Error("Usage: node write-final-auto-html.mjs <results.json> <output.html>");

const result = JSON.parse(await fs.readFile(resultsPath, "utf8"));
const cases = result.cases.filter((row) => row.attempted);
if (cases.length !== 36 || new Set(cases.map((row) => row.case_id)).size !== 36) {
  throw new Error("Expected 36 unique executed automation cases");
}
if (cases.some((row) => !["passed", "business_failure"].includes(row.status))) {
  throw new Error("An executed case has no final pass/fail result");
}

const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const passed = cases.filter((row) => row.status === "passed").length;
const failed = cases.length - passed;
const rows = cases.map((row) => {
  const label = row.status === "passed" ? "通过" : "不通过";
  const title = row.title.replace(/^用例-[0-9]{4}:\s*/u, "");
  return `<tr><td>${escapeHtml(row.case_id)}</td><td>${escapeHtml(title)}</td><td><span class="status ${row.status === "passed" ? "pass" : "fail"}">${label}</span></td></tr>`;
}).join("\n");

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BUG1004949 自动化测试最终结果</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f8fb;color:#203047;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}main{max-width:960px;margin:32px auto;padding:32px;background:#fff;border:1px solid #e2e8f0;border-radius:12px}h1{font-size:24px;margin:0 0 18px}.summary{display:flex;gap:12px;margin-bottom:22px}.summary div{min-width:130px;padding:13px 18px;border-radius:8px;background:#f1f5f9}.summary strong{display:block;font-size:24px}.summary span{color:#5b6879}table{width:100%;border-collapse:collapse}th,td{padding:11px 12px;border-bottom:1px solid #e7edf3;text-align:left}th{background:#eff3f8;color:#3b4a5b}td:first-child{white-space:nowrap;width:120px}td:last-child{width:110px}.status{display:inline-block;border-radius:999px;padding:3px 11px;font-weight:600}.pass{background:#e6f4e9;color:#216b38}.fail{background:#fbe8e7;color:#b42318}@media(max-width:620px){main{margin:0;padding:16px;border-radius:0}.summary div{min-width:0;flex:1}table{font-size:13px}td:first-child{width:100px}}
</style></head><body><main><h1>BUG1004949 自动化测试最终结果</h1><div class="summary"><div><strong>${cases.length}</strong><span>已执行</span></div><div><strong>${passed}</strong><span>通过</span></div><div><strong>${failed}</strong><span>不通过</span></div></div><table><thead><tr><th>用例编号</th><th>用例</th><th>最终结果</th></tr></thead><tbody>${rows}</tbody></table></main></body></html>`;
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, html, "utf8");
console.log(JSON.stringify({ outputPath, executed: cases.length, passed, failed }));
