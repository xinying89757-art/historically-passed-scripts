#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { isLoginPage, saveStorageState } from "./auth.mjs";
import { readRankingWorkbook } from "./ranking-input.mjs";
import { writeReports } from "./report.mjs";
import { provisionBlocks, summarizeState } from "./runner.mjs";
import { resetBlockForRetry, StateStore } from "./state.mjs";

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) options[key] = inlineValue;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) options[key] = argv[++index];
    else options[key] = true;
  }
  return options;
}

function positiveInteger(value, name) {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} 必须是大于0的整数`);
  return parsed;
}

function print(value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function inputFor(config) {
  return readRankingWorkbook(config.rankingWorkbook, config.rankingSheetName);
}

async function auth(config) {
  const { context, page } = await launchEditorBrowser(config, { headless: false, slowMo: 0 });
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    await page.goto(config.editorUrl, { waitUntil: "domcontentloaded" });
    stdout.write("\n已打开独立Chrome。请完成登录并进入目标3.0编辑器，然后回到终端。\n");
    await terminal.question("完成后按Enter保存登录状态并关闭浏览器：");
    if (await isLoginPage(page)) {
      throw new Error("人工登录流程结束后仍停留在登录页，未保存登录状态");
    }
    const statePath = await saveStorageState(context, config);
    stdout.write(`登录状态已保存：${statePath || config.paths.userDataDir}\n`);
  } finally {
    terminal.close();
    await context.close();
  }
}

async function login(config, options) {
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: 0,
  });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const statePath = await saveStorageState(context, config);
    print({
      ok: true,
      siteName: config.siteName,
      siteLanguage: config.siteLanguage,
      publicBaseUrl: config.publicBaseUrl,
      statePath,
    });
  } finally {
    await context.close();
  }
}

async function probe(config, options) {
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: 0,
  });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    const result = await editor.inspect();
    await mkdir(config.paths.artifactsDir, { recursive: true });
    const target = path.join(config.paths.artifactsDir, `probe-${Date.now()}.json`);
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    print({ ok: true, currentUrl: result.pageUrl, title: result.title, artifact: target });
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "help";
  if (command === "help" || options.help) {
    stdout.write(`3.0区块自动化命令：
  npm run plan
  npm run auth
  npm run login
  npm run add:poc
  npm run add
  npm run resume
  npm run status
  npm run retry:block -- --block-id 12345
  npm run heading:poc
  npm run heading:ids -- --block-ids 12345,67890
  npm run heading
  npm run heading:report
  npm run ai:poc
  npm run ai:add
  npm run ai:resume
  npm run ai:status

所有命令均可追加：--config config/run.json
`);
    return;
  }

  const config = await loadConfig(options.config ?? "config/run.json");
  if (command === "auth") return auth(config);
  if (command === "login") return login(config, options);
  if (command === "probe") return probe(config, options);
  const input = await inputFor(config);
  const store = new StateStore(config.paths.stateFile);

  if (command === "plan") {
    print({
      workbook: input.workbookPath,
      sheet: input.sheetName,
      sourceRows: input.sourceRowCount,
      includedRows: input.includedRows,
      uniqueBlocks: input.blocks.length,
      duplicateBlocks: input.duplicates,
      excludedRows: input.excluded.length,
      blocksPerPage: config.blocksPerPage,
      estimatedPages: Math.ceil(input.blocks.length / config.blocksPerPage),
      firstEightTemplateSamples: input.blocks.slice(0, 8).map((record) => ({
        block_id: record.block_id,
        block_name: record.block_name,
        template_types: record.template_types,
      })),
    });
    return;
  }

  if (command === "status") {
    const state = await store.load();
    if (!state) return print({ initialized: false, message: "尚无运行状态" });
    if (state.input_checksum !== input.checksum) throw new Error("工作簿已变化，不能复用旧状态");
    await writeReports(state, config.paths.reportsDir);
    print({ initialized: true, ...summarizeState(state), stateFile: config.paths.stateFile, reportsDir: config.paths.reportsDir });
    return;
  }

  if (command === "retry") {
    if (!options.apply) throw new Error("重置状态必须显式传 --apply");
    if (!options.blockId) throw new Error("retry 必须传 --block-id");
    const state = await store.load();
    if (!state) throw new Error("任务尚未初始化");
    const record = resetBlockForRetry(state, options.blockId);
    await store.save(state);
    await writeReports(state, config.paths.reportsDir);
    print({ ok: true, resetBlockId: record.block_id, nextCsvIndex: state.next_csv_index });
    return;
  }

  if (["add", "resume"].includes(command)) {
    if (!options.apply) throw new Error(`${command}会创建并保存页面，必须显式传 --apply`);
    const result = await provisionBlocks({
      config,
      input,
      store,
      maxBlocks: positiveInteger(options.maxBlocks, "--max-blocks"),
      maxPages: positiveInteger(options.maxPages, "--max-pages"),
      headless: options.headless === true,
    });
    print({
      ok: true,
      successfullyAddedThisRun: result.successfullyAddedThisRun,
      savedPagesThisRun: result.savedPagesThisRun,
      trace: result.tracePath,
      summary: summarizeState(result.state),
    });
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
