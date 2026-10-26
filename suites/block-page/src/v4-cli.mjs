#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { readV4BlockCsv } from "./v4-input.mjs";
import { V4Editor, launchV4Browser } from "./v4-editor.mjs";
import { writeV4Reports } from "./v4-report.mjs";
import { runV4Blocks } from "./v4-runner.mjs";
import { V4StateStore, configuredV4Targets, resetV4RecordsForRetry, summarizeV4State, syncV4PublicUrls } from "./v4-state.mjs";

function parseArgs(argv) {
  const options = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      options._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = rawKey.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
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

function byCategory(records, categories) {
  return Object.fromEntries(categories.map((category) => [category, records.filter((item) => item.category === category)]));
}

async function commandPlan(config, input) {
  const candidates = byCategory(input.candidates, config.v4Categories);
  const excluded = byCategory(input.excluded, config.v4Categories);
  const targets = configuredV4Targets(input, config);
  print({
    inputCsv: input.csvPath,
    encoding: "GB18030",
    sourceRows: input.sourceRowCount,
    eligible: Object.fromEntries(config.v4Categories.map((category) => [category, candidates[category].length])),
    excluded: Object.fromEntries(config.v4Categories.map((category) => [category, excluded[category].length])),
    targetMode: config.v4TargetMode ?? "fixed",
    targetsByCategory: targets,
    proxyServer: config.proxyServer ?? "",
    blocksPerPage: config.blocksPerPage,
    expectedPages: Object.values(targets).reduce(
      (sum, target) => sum + Math.ceil(target / config.blocksPerPage),
      0,
    ),
    firstTwenty: Object.fromEntries(config.v4Categories.map((category) => [category, candidates[category].slice(0, 20).map((item) => item.block_id)])),
  });
}

async function commandAuth(config) {
  const { context, page } = await launchV4Browser(config, { headless: false, slowMo: 0 });
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    await page.goto(config.v4EntryUrl, { waitUntil: "domcontentloaded" });
    stdout.write(`\n已打开“我的网站”。请登录后保持在站点列表页，再回到任务中告诉我。\n`);
    await terminal.question("确认登录完成后按 Enter 关闭窗口并保存状态：");
  } finally {
    terminal.close();
    await context.close();
  }
}

async function commandProbe(config, options) {
  const { context, page } = await launchV4Browser(config, { headless: options.headless === true, slowMo: 0 });
  try {
    const editor = new V4Editor(page, config);
    await editor.goto();
    if (options.openPageMenu) await editor.openPageMenu();
    const probe = await editor.inspect();
    const directory = path.join(config.paths.v4ArtifactsDir, "probe");
    await mkdir(directory, { recursive: true });
    const run = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    const jsonPath = path.join(directory, `${run}.json`);
    const screenshotPath = path.join(directory, `${run}.png`);
    await writeFile(jsonPath, `${JSON.stringify(probe, null, 2)}\n`, "utf8");
    await editor.page.screenshot({ path: screenshotPath, fullPage: true });
    print({ ok: true, pageUrl: editor.page.url(), title: await editor.page.title(), jsonPath, screenshotPath });
  } finally {
    await context.close();
  }
}

async function commandStatus(config, input, store) {
  const state = await store.load();
  if (!state) {
    print({ initialized: false, message: "尚无4.0区块运行状态" });
    return;
  }
  if (state.input_checksum !== input.checksum) throw new Error("当前4.0 CSV与状态文件校验值不一致");
  if (syncV4PublicUrls(state, config) > 0) await store.save(state);
  await writeV4Reports(state, config.paths.v4ReportsDir);
  print({
    initialized: true,
    ...summarizeV4State(state),
    lastError: state.last_error ?? "",
    stateFile: config.paths.v4StateFile,
    reportsDir: config.paths.v4ReportsDir,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "help";
  if (command === "help" || options.help) {
    stdout.write(`用法：
  node src/v4-cli.mjs plan
  node src/v4-cli.mjs auth
  node src/v4-cli.mjs probe [--open-page-menu]
  node src/v4-cli.mjs run --apply [--max-pages 1]
  node src/v4-cli.mjs resume --apply [--max-pages 1]
  node src/v4-cli.mjs retry --apply --block-ids 45364,39634
  node src/v4-cli.mjs status
`);
    return;
  }
  const config = await loadConfig(options.config ?? "config/v4-blocks.json");
  const input = await readV4BlockCsv(config.v4Csv, config.v4Categories, {
    includeCustomized: config.v4IncludeCustomized === true,
  });
  const store = new V4StateStore(config.paths.v4StateFile);
  if (command === "plan") return commandPlan(config, input);
  if (command === "auth") return commandAuth(config);
  if (command === "probe") return commandProbe(config, options);
  if (command === "status") return commandStatus(config, input, store);
  if (["run", "resume", "retry"].includes(command)) {
    if (!options.apply) throw new Error(`${command} 是写入操作，必须显式传入 --apply`);
    if (command === "retry") {
      const blockIds = String(options.blockIds ?? "").split(",").map((value) => value.trim()).filter(Boolean);
      if (blockIds.length === 0) throw new Error("retry 必须通过 --block-ids 指定区块ID");
      const state = await store.load();
      if (!state) throw new Error("尚无可重试的4.0运行状态");
      resetV4RecordsForRetry(state, blockIds);
      await store.save(state);
      await writeV4Reports(state, config.paths.v4ReportsDir);
    }
    const state = await runV4Blocks({
      config,
      input,
      store,
      maxPages: positiveInteger(options.maxPages, "max-pages"),
    });
    print({ ok: true, ...summarizeV4State(state), stateFile: config.paths.v4StateFile, reportsDir: config.paths.v4ReportsDir });
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
