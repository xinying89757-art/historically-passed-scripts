import fs from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile } from "@oai/artifact-tool";

const [inputPath, outputPath, previewPath] = process.argv.slice(2);
if (!inputPath || !outputPath || !previewPath) {
  throw new Error("Usage: update-final-0017.mjs <input.xlsx> <output.xlsx> <preview.png>");
}

const workbook = await SpreadsheetFile.importXlsx(await FileBlob.load(inputPath));
if (workbook.worksheets.items.length !== 1 || workbook.worksheets.getItemAt(0).name !== "测试用例") {
  throw new Error("Final workbook must contain only the 测试用例 sheet");
}

const sheet = workbook.worksheets.getItem("测试用例");
const ids = sheet.getRange("A5:A54").values.flat().map((value) => String(value ?? ""));
if (ids.length !== 50 || new Set(ids).size !== 50) {
  throw new Error(`Expected 50 unique cases, found ${ids.length}`);
}
const rowNumber = ids.indexOf("用例-0017") + 5;
if (rowNumber < 5) throw new Error("用例-0017 was not found");

sheet.getRange(`C${rowNumber}`).values = [["自建页面设置密码访问后，输入正确密码可展示页面内容"]];
sheet.getRange(`E${rowNumber}`).values = [["已准备自建页面“BUG1004949 Password Page”，前台地址为 /bug1004949/password.html；准备页面访问密码 123456；使用未完成该页面密码验证的前台浏览器上下文。"]];
sheet.getRange(`F${rowNumber}`).values = [[
  "1. 进入“编辑网站”，打开自建页面“BUG1004949 Password Page”。\n" +
  "2. 打开“当前页面设置”，在“访问权限”中选择“密码访问”。\n" +
  "3. 输入页面访问密码 123456，并确认权限设置。\n" +
  "4. 勾选发布协议并发布网站。\n" +
  "5. 重新进入该自建页面的访问权限设置，确认仍为密码访问且保存的密码与测试密码一致。\n" +
  "6. 清除前台 Cookie，打开 /bug1004949/password.html。\n" +
  "7. 确认页面显示密码访问提示且未展示自建页面内容。\n" +
  "8. 输入正确密码并点击 OK。\n" +
  "9. 查看页面内容。",
]];
sheet.getRange(`G${rowNumber}`).values = [[
  "1. 可打开目标自建页面。\n" +
  "2. “密码访问”被选中。\n" +
  "3. 权限设置确认成功。\n" +
  "4. 网站发布成功。\n" +
  "5. 后台重新打开后，密码访问模式和测试密码均已持久化。\n" +
  "6. 前台地址正常打开，不显示 404 页面。\n" +
  "7. 页面显示密码输入框，不显示受保护内容。\n" +
  "8. 密码验证成功，密码输入页消失。\n" +
  "9. 页面显示自建页面内容。",
]];
sheet.getRange(`K${rowNumber}`).values = [["通过"]];
sheet.getRange(`L${rowNumber}`).values = [[
  "脚本已在“编辑网站”中将自建页面设置为密码访问，发布后重新打开后台确认密码模式和测试密码均已保存；清除前台 Cookie 后访问 /bug1004949/password.html，输入正确密码后密码页消失并显示自建页面内容。",
]];

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const exported = await SpreadsheetFile.exportXlsx(workbook);
await exported.save(outputPath);

const saved = await SpreadsheetFile.importXlsx(await FileBlob.load(outputPath));
const savedSheet = saved.worksheets.getItem("测试用例");
const savedIds = savedSheet.getRange("A5:A54").values.flat().map((value) => String(value ?? ""));
const statusReasonRows = savedSheet.getRange("K5:L54").values;
if (saved.worksheets.items.length !== 1 || savedIds.length !== 50 || new Set(savedIds).size !== 50) {
  throw new Error("Saved workbook structure verification failed");
}
if (statusReasonRows.some((row) => !String(row[0] ?? "").trim() || !String(row[1] ?? "").trim())) {
  throw new Error("At least one case is missing status or reason");
}
const savedRow = savedSheet.getRange(`A${rowNumber}:L${rowNumber}`).values[0];
if (savedRow[0] !== "用例-0017" || savedRow[10] !== "通过" || !String(savedRow[11]).includes("密码页消失")) {
  throw new Error("用例-0017 result verification failed");
}

const errors = await saved.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A|#NUM!|#NULL!|#SPILL!|#CALC!",
  options: { useRegex: true, maxResults: 100 },
  summary: "final formula error scan",
});
if (/"matches":\s*[1-9]/u.test(errors.ndjson)) throw new Error(`Formula errors found: ${errors.ndjson}`);

const preview = await saved.render({ sheetName: "测试用例", range: `A${rowNumber - 2}:L${rowNumber + 2}`, scale: 1.5, format: "png" });
await fs.writeFile(previewPath, new Uint8Array(await preview.arrayBuffer()));

const counts = Object.fromEntries(
  [...new Set(statusReasonRows.map((row) => String(row[0])))].sort()
    .map((status) => [status, statusReasonRows.filter((row) => String(row[0]) === status).length]),
);
console.log(JSON.stringify({ outputPath, rowNumber, counts, formulaErrors: errors.ndjson }, null, 2));
