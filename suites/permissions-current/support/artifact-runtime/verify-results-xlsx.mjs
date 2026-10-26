import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [inputPath, previewPath, expectedPath] = process.argv.slice(2);
if (!inputPath || !previewPath) throw new Error("Usage: verify-results-xlsx.mjs <input.xlsx> <preview.png>");

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
const sheet = workbook.worksheets.getItem("测试用例");
const statusRows = sheet.getRange("A3:K44").values;
const headers = statusRows[0];
const data = statusRows.slice(2);
const statusIndex = headers.indexOf("状态");
const reasonIndex = headers.indexOf("原因");
if (statusIndex < 0 || reasonIndex < 0) throw new Error("状态或原因列缺失");

const statuses = data.map((row) => String(row[statusIndex] ?? ""));
const counts = Object.fromEntries([...new Set(statuses)].sort().map((status) => [status, statuses.filter((value) => value === status).length]));
if (data.length !== 40) throw new Error(`Expected 40 source cases, found ${data.length}`);
if (data.some((row) => !row[0] || !row[statusIndex] || !row[reasonIndex])) {
  throw new Error("最终报告存在缺少编号、状态或原因的用例行");
}

if (expectedPath) {
  const parsedExpected = JSON.parse(await fs.readFile(expectedPath, "utf8"));
  const expectedRows = Array.isArray(parsedExpected) ? parsedExpected : parsedExpected.cases;
  if (!Array.isArray(expectedRows)) throw new Error("Expected result input must contain cases");
  const statusLabels = {
    passed: "通过",
    business_failure: "不通过",
    automation_failure: "自动化失败",
    environment_blocked: "环境阻塞",
    product_confirmation: "待产品确认",
    interrupted: "自动化失败",
  };
  const expectedById = new Map(expectedRows.map((row) => [row.case_id, statusLabels[row.status] ?? String(row.status)]));
  for (const row of data) {
    const id = String(row[0]);
    const expectedStatus = expectedById.get(id) ?? "未执行";
    const actualStatus = String(row[statusIndex]);
    if (actualStatus !== expectedStatus) {
      throw new Error(`Status projection mismatch for ${id}: expected=${expectedStatus}, actual=${actualStatus}`);
    }
  }
}

const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 50 },
  summary: "final formula error scan",
});
if (/"matches":\s*[1-9]/u.test(errors.ndjson)) throw new Error(`Formula errors found: ${errors.ndjson}`);

const preview = await workbook.render({ sheetName: "测试用例", range: "I1:K44", scale: 1, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
console.log(JSON.stringify({ rows: data.length, counts, headers: headers.slice(-2) }, null, 2));
