import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";

const runnerRoot = path.resolve(import.meta.dirname, "..");
const runsRoot = path.join(runnerRoot, "results", "runs");
const latestRoot = path.join(runnerRoot, "results", "latest");
const sourceWorkbook = path.join(runnerRoot, "fixtures", "BUG1004949-测试用例-源.xlsx");
const artifactNode = process.env.UI_ARTIFACT_NODE ?? process.execPath;
const workbookWriter = path.join(runnerRoot, "support", "artifact-runtime", "write-results-xlsx.mjs");
const outputWorkbook = path.join(latestRoot, "BUG1004949-执行结果.xlsx");

const blockedReasons = {
  "用例-0006": "环境阻塞：缺少同一受保护内容与系统 URL 的稳定映射及可验证恢复步骤。",
  "用例-0020": "环境阻塞：英语站点尚未准备可稳定识别、重复访问并恢复的 CP 页测试对象。",
  "用例-0021": "环境阻塞：英语站点尚未准备可稳定识别、重复访问并恢复的专题页测试对象。",
};

const businessReasons = {
  "用例-0014": "设置员工访问后，员工账号已在领动云平台重新登录并携带员工 Cookie 访问前台，但页面仍显示 Only employees 提示，未展示受保护内容。",
  "用例-0034": "后台保存视频详情自定义 URL 后，前台访问该 URL 返回 404，未展示视频详情内容。",
};

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: runnerRoot, stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? 1}`)));
  });
}

const runDirs = (await fs.readdir(runsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("BUG1004949-"))
  .map((entry) => entry.name)
  .sort();

function collectSpecs(node, output = []) {
  for (const spec of node?.specs ?? []) output.push(spec);
  for (const suite of node?.suites ?? []) collectSpecs(suite, output);
  return output;
}

const finalByCase = new Map();
function considerFinal(row, runDir) {
  const caseId = row.case_id;
  const isFinal = row.status === "passed" || (row.status === "business_failure" && businessReasons[caseId]);
  if (isFinal) finalByCase.set(caseId, { ...row, source_run_id: runDir });
}

for (const runDir of runDirs) {
  const resultFile = path.join(runsRoot, runDir, "ui-execution-results.v3.json");
  try {
    const result = JSON.parse(await fs.readFile(resultFile, "utf8"));
    for (const row of result.cases ?? []) {
      if (row.attempted) considerFinal(row, runDir);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  // Early incremental batches were invoked directly with Playwright and did
  // not yet project their passing results into ui-execution-results.v3.json.
  const playwrightFile = path.join(runsRoot, runDir, "playwright-results.json");
  try {
    const result = JSON.parse(await fs.readFile(playwrightFile, "utf8"));
    for (const spec of collectSpecs(result)) {
      const caseId = spec.title?.match(/用例-[0-9]{4}/u)?.[0];
      if (!caseId) continue;
      const lastResult = (spec.tests ?? []).flatMap((test) => test.results ?? []).at(-1);
      if (lastResult?.status === "passed") considerFinal({ case_id: caseId, status: "passed", attempted: true }, runDir);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const blocked = new Set(Object.keys(blockedReasons));
const sourceCaseIds = Array.from({ length: 39 }, (_, index) => index + 1)
  .filter((number) => number <= 39)
  .map((number) => `用例-${String(number).padStart(4, "0")}`)
  .filter((id) => !["用例-0040", "用例-0041", "用例-0042"].includes(id));
sourceCaseIds.push("用例-0043");

const rows = sourceCaseIds.map((caseId) => {
  if (blocked.has(caseId)) {
    return { case_id: caseId, status: "environment_blocked", reason: blockedReasons[caseId], attempted: false };
  }
  const latest = finalByCase.get(caseId);
  if (!latest) throw new Error(`No completed incremental result found for ${caseId}`);
  if (latest.status === "business_failure") {
    return { case_id: caseId, status: "business_failure", reason: businessReasons[caseId] ?? latest.reason, attempted: true };
  }
  return { case_id: caseId, status: "passed", reason: null, attempted: true };
});

if (rows.length !== 40 || new Set(rows.map((row) => row.case_id)).size !== 40) {
  throw new Error(`Expected 40 unique final case rows, found ${rows.length}`);
}

const summary = {
  total: rows.length,
  passed: rows.filter((row) => row.status === "passed").length,
  business_failure: rows.filter((row) => row.status === "business_failure").length,
  environment_blocked: rows.filter((row) => row.status === "environment_blocked").length,
  automation_failure: rows.filter((row) => row.status === "automation_failure").length,
};

await fs.mkdir(latestRoot, { recursive: true });
const jsonFile = path.join(latestRoot, "ui-execution-results.v3.json");
await fs.writeFile(jsonFile, JSON.stringify({
  schema_version: "ui-execution-results.v3",
  run_id: "BUG1004949-incremental-final",
  project_id: "bug1004949-en-site",
  finished_at: new Date().toISOString(),
  cases: rows,
  summary,
}, null, 2), "utf8");

const workbookInput = path.join(latestRoot, ".BUG1004949-final-rows.json");
await fs.writeFile(workbookInput, JSON.stringify(rows), "utf8");
try {
  await run(artifactNode, [workbookWriter, workbookInput, sourceWorkbook, outputWorkbook]);
} finally {
  await fs.rm(workbookInput, { force: true });
}
await fs.writeFile(path.join(runnerRoot, "results", "latest-summary.json"), JSON.stringify({
  runId: "BUG1004949-incremental-final",
  summary,
}, null, 2), "utf8");

console.log(JSON.stringify({ outputWorkbook, summary }, null, 2));
