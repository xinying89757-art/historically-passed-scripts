#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as inputStream, stdout as outputStream } from "node:process";
import { loadConfig } from "./config.mjs";
import { LeadongEditor, launchEditorBrowser } from "./editor.mjs";
import { readV3FullInput } from "./v3-full-input.mjs";
import { writeV3FullReports } from "./v3-full-report.mjs";
import { writeV3FullFinalReports } from "./v3-full-final-report.mjs";
import { runV3FullAdd } from "./v3-full-runner.mjs";
import {
  prepareFastV3FullHeadingState,
  prepareRetryV3FullHeadingState,
  runV3FullHeadings,
  selectV3FullHeadingPocRecords,
} from "./v3-full-heading-runner.mjs";
import { loadOrCreateV3FullState, summarizeV3FullState } from "./v3-full-state.mjs";

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) { options[key] = next; index += 1; } else options[key] = true;
  }
  return { command: positional[0] ?? "status", options };
}

function requireApply(options) {
  if (!options.apply) throw new Error("写入命令必须显式传入 --apply");
}

async function context(options) {
  const config = await loadConfig(options.config ?? "config/v3-full-heading.json");
  const input = await readV3FullInput(config.v3FullInputDir);
  const { state, store } = await loadOrCreateV3FullState(input, config);
  return { config, input, state, store };
}

async function auth(options) {
  const config = await loadConfig(options.config ?? "config/v3-full-heading.json");
  const { context: browser, page } = await launchEditorBrowser(config, { headless: false, slowMo: 80 });
  try {
    try {
      // Auth mode is deliberately less strict than a run: the user may need
      // to choose the target site/language manually before the editor popup is
      // created. Open the portal and keep the visible browser alive.
      await page.goto("https://www.leadong.com/website.html", {
        waitUntil: "commit",
        timeout: 60000,
      });
    } catch (error) {
      if (!/ERR_ABORTED|Navigation interrupted/u.test(`${error.message}`)) {
        throw error;
      }
    }
    const rl = readline.createInterface({ input: inputStream, output: outputStream });
    await rl.question("请在可见Chrome中完成登录，选择nanjing／英语并进入3.0编辑器后按回车保存登录状态：");
    rl.close();
  } finally {
    await browser.close();
  }
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "auth") return auth(options);
  const run = await context(options);
  if (command === "plan" || command === "status") {
    await writeV3FullReports(run.state, run.config.paths.v3FullReportsDir);
    const summary = summarizeV3FullState(run.state);
    process.stdout.write(`${JSON.stringify({ ...summary, reportsDir: run.config.paths.v3FullReportsDir, stateFile: run.config.paths.v3FullStateFile }, null, 2)}\n`);
    return;
  }
  if (command === "report") {
    await writeV3FullReports(run.state, run.config.paths.v3FullReportsDir);
    process.stdout.write(`${run.config.paths.v3FullReportsDir}\n`);
    return;
  }
  if (command === "final-report") {
    const result = await writeV3FullFinalReports(run.state, run.config.paths.v3FullReportsDir);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (["add", "add-poc", "resume"].includes(command)) {
    requireApply(options);
    const result = await runV3FullAdd({
      ...run,
      maxPages: Number(options.maxPages ?? (command === "add-poc" ? 1 : 0)),
      maxBlocks: Number(options.maxBlocks ?? (command === "add-poc" ? 6 : 0)),
      headless: options.headless === true,
    });
    process.stdout.write(`${JSON.stringify({ ...result, summary: summarizeV3FullState(run.state) }, null, 2)}\n`);
    return;
  }
  if (["h-poc", "h-run", "h-resume", "h-resume-fast", "h-retry-fast"].includes(command)) {
    requireApply(options);
    const retry = command === "h-retry-fast";
    const fast = retry || command === "h-resume-fast" || options.writeMode === "ckeditor_api";
    const preparation = retry
      ? await prepareRetryV3FullHeadingState(run.state, run.store, run.config.paths.v3FullStateFile)
      : fast
        ? await prepareFastV3FullHeadingState(run.state, run.store, run.config.paths.v3FullStateFile)
        : null;
    const pocRecords = command === "h-poc" ? selectV3FullHeadingPocRecords(run.state) : [];
    const result = await runV3FullHeadings({
      ...run,
      maxPages: Number(options.maxPages ?? 0),
      headless: options.headless === true,
      pageName: options.pageName ?? null,
      selectedIds: command === "h-poc" ? new Set(pocRecords.map((record) => record.block_id)) : null,
      writeMode: fast ? "ckeditor_api" : "ui",
    });
    process.stdout.write(`${JSON.stringify({ ...result, preparation, pocBlockIds: pocRecords.map((record) => record.block_id), summary: summarizeV3FullState(run.state) }, null, 2)}\n`);
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
