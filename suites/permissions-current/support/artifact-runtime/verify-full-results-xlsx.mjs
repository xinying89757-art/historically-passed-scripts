import fs from "node:fs/promises";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [outputPath, sourcePath, resultPath, previewPath] = process.argv.slice(2);
if (!outputPath || !sourcePath || !resultPath || !previewPath) {
  throw new Error("Usage: verify-full-results-xlsx.mjs <output.xlsx> <source.xlsx> <results.json> <preview.png>");
}
const [workbook, source, result] = await Promise.all([
  SpreadsheetFile.importXlsx(await FileBlob.load(outputPath)),
  SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath)),
  fs.readFile(resultPath, "utf8").then(JSON.parse),
]);
const sheet = workbook.worksheets.getItem("测试用例");
const sourceSheet = source.worksheets.getItem("测试用例");
if (JSON.stringify(sheet.getRange("A1:J54").values) !== JSON.stringify(sourceSheet.getRange("A1:J54").values)) {
  throw new Error("Existing case details changed during result update");
}
const headers = sheet.getRange("K3:L3").values[0];
if (headers[0] !== "自动化测试结果" || headers[1] !== "原因") throw new Error("Result columns changed");
const data = sheet.getRange("A5:L54").values;
const byId = new Map(result.cases.map((row) => [row.case_id, row]));
const labels = {
  passed: "通过", business_failure: "不通过", automation_failure: "自动化失败",
  environment_blocked: "环境阻塞", product_confirmation: "待产品确认",
};
if (data.length !== 50 || new Set(data.map((row) => row[0])).size !== 50 || byId.size !== 40) {
  throw new Error("Expected 50 source cases and 40 automation results");
}
for (const row of data) {
  const resultRow = byId.get(row[0]);
  if (!resultRow) {
    if (row[10] !== "人工测试" || !row[11]) throw new Error(`Manual case lost its result: ${row[0]}`);
  } else if (row[10] !== labels[resultRow.status] || row[11] !== resultRow.reason) {
    throw new Error(`Result mismatch for ${row[0]}`);
  }
}
const errors = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 50 },
  summary: "formula error scan",
});
if (/"matches":\s*[1-9]/u.test(errors.ndjson)) throw new Error(`Formula errors found: ${errors.ndjson}`);
const preview = await workbook.render({ sheetName: "测试用例", range: "J3:L12", scale: 2, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));
const counts = Object.fromEntries([...new Set(data.map((row) => row[10]))].map((status) => [status, data.filter((row) => row[10] === status).length]));
console.log(JSON.stringify({ cases: data.length, counts }, null, 2));
