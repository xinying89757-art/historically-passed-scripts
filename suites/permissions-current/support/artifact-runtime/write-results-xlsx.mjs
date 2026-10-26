import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [inputPath, sourcePath, outputPath] = process.argv.slice(2);
if (!inputPath || !sourcePath || !outputPath) {
  throw new Error("Usage: write-results-xlsx.mjs <results.json> <source.xlsx> <output.xlsx>");
}

const parsedRows = JSON.parse(await fs.readFile(inputPath, "utf8"));
const rows = Array.isArray(parsedRows) ? parsedRows : parsedRows.cases;
if (!Array.isArray(rows)) throw new Error("Result input must be a case array or ui-execution-results object");
const byId = new Map(rows.map((row) => [row.case_id, row]));
const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(sourcePath));
const sheet = workbook.worksheets.getItem("测试用例");
const sourceIds = sheet.getRange("A5:A44").values.flat().map((value) => String(value ?? ""));

if (sourceIds.length !== 40 || new Set(sourceIds).size !== 40 || sourceIds.some((id) => !/^用例-[0-9]{4}$/u.test(id))) {
  throw new Error("Source workbook must contain 40 unique case IDs in 测试用例!A5:A44");
}

const statusLabels = {
  passed: "通过",
  business_failure: "不通过",
  automation_failure: "自动化失败",
  environment_blocked: "环境阻塞",
  product_confirmation: "待产品确认",
  interrupted: "自动化失败",
};
const values = sourceIds.map((id) => {
  const row = byId.get(id);
  if (!row) return ["未执行", "不在本轮执行范围内。"];
  const status = statusLabels[row.status] ?? String(row.status ?? "未执行");
  const reason = row.reason ? String(row.reason) : status === "通过" ? "断言通过。" : "未记录原因。";
  return [status, reason];
});

sheet.getRange("J3:K3").values = [["状态", "原因"]];
sheet.getRange("J5:K44").values = values;
sheet.getRange("J3:K3").format = {
  fill: "#1F4E3D",
  font: { bold: true, color: "#FFFFFF", typeface: "Arial", fontSize: 10 },
  horizontalAlignment: "center",
  verticalAlignment: "center",
  wrapText: true,
  borders: { preset: "outside", style: "thin", color: "#D9E2DE" },
};
sheet.getRange("J5:K44").format = {
  font: { color: "#222222", typeface: "Arial", fontSize: 10 },
  verticalAlignment: "top",
  wrapText: true,
};
sheet.getRange("J5:J44").format.horizontalAlignment = "center";
sheet.getRange("J3:J44").format.columnWidth = 14;
sheet.getRange("K3:K44").format.columnWidth = 64;
sheet.getRange("J5:J44").conditionalFormats.add("containsText", { text: "通过", format: { fill: "#E2F0D9", font: { color: "#375623" } } });
sheet.getRange("J5:J44").conditionalFormats.add("containsText", { text: "不通过", format: { fill: "#FCE4D6", font: { color: "#C00000", bold: true } } });
sheet.getRange("J5:J44").conditionalFormats.add("containsText", { text: "环境阻塞", format: { fill: "#FFF2CC", font: { color: "#7F6000", bold: true } } });
sheet.getRange("J5:J44").conditionalFormats.add("containsText", { text: "自动化失败", format: { fill: "#F4CCCC", font: { color: "#990000", bold: true } } });
sheet.freezePanes.freezeRows(3);

const writtenHeaders = sheet.getRange("J3:K3").values[0];
if (writtenHeaders?.[0] !== "状态" || writtenHeaders?.[1] !== "原因") {
  throw new Error("Result columns were not written to the source test cases");
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const output = await SpreadsheetFile.exportXlsx(workbook);
await output.save(outputPath);
