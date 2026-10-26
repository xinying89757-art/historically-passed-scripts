import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [resultsPath, sourcePath, outputPath] = process.argv.slice(2);
if (!resultsPath || !sourcePath || !outputPath) {
  throw new Error("Usage: write-full-results-xlsx.mjs <results.json> <source-50.xlsx> <output.xlsx>");
}
const result = JSON.parse(await fs.readFile(resultsPath, "utf8"));
const rows = Array.isArray(result) ? result : result.cases;
if (!Array.isArray(rows) || rows.length !== 40) throw new Error("Expected 40 automation result rows");
const byId = new Map(rows.map((row) => [row.case_id, row]));
if (byId.size !== 40) throw new Error("Duplicate automation case ID");

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath));
const sheet = workbook.worksheets.getItem("测试用例");
const headers = sheet.getRange("K3:L3").values[0];
if (headers[0] !== "自动化测试结果" || headers[1] !== "原因") {
  throw new Error("Full source workbook does not have the expected result columns");
}
const ids = sheet.getRange("A5:A54").values.flat().map((value) => String(value ?? ""));
const existing = sheet.getRange("K5:L54").values;
if (ids.length !== 50 || new Set(ids).size !== 50 || ids.some((id) => !/^用例-[0-9]{4}$/u.test(id))) {
  throw new Error("Full source workbook must contain 50 unique case IDs");
}
const labels = {
  passed: "通过",
  business_failure: "不通过",
  automation_failure: "自动化失败",
  environment_blocked: "环境阻塞",
  product_confirmation: "待产品确认",
};
let updated = 0;
const values = ids.map((id, index) => {
  const row = byId.get(id);
  if (!row) {
    if (existing[index][0] !== "人工测试" || !existing[index][1]) {
      throw new Error(`Unexecuted case is not marked for manual testing: ${id}`);
    }
    return existing[index];
  }
  updated += 1;
  const label = labels[row.status];
  if (!label || !row.reason) throw new Error(`Case lacks a status or reason: ${id}`);
  return [label, String(row.reason)];
});
if (updated !== 40) throw new Error(`Only ${updated} automation cases matched the full workbook`);
sheet.getRange("K5:L54").values = values;

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
