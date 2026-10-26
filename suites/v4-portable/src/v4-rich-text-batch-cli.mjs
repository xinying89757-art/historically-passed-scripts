#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";
import { loadV4RichTextBatchState, runV4RichTextBatch, summarizeV4RichTextBatch } from "./v4-rich-text-batch.mjs";
import { writeV4RichTextBatchReports } from "./v4-rich-text-batch-report.mjs";

function parseArgs(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) result._.push(token);
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) result[token.slice(2)] = argv[++index];
    else result[token.slice(2)] = true;
  }
  return result;
}

function paths(config) {
  const settings = config.v4RichTextBatch ?? {};
  return {
    statePath: path.resolve(projectRoot, settings.stateFile ?? ".state/v4-rich-text-batch-state.json"),
    artifactsDir: path.resolve(projectRoot, settings.artifactsDir ?? "artifacts/v4-rich-text-batch"),
    reportsDir: path.resolve(projectRoot, settings.reportsDir ?? "reports/v4-rich-text-batch"),
  };
}

function maxPages(value) {
  if (value === undefined) return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("max-pages必须是正整数");
  return parsed;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? "help";
  const config = await loadConfig("config/v4-blocks.json");
  const location = paths(config);
  const writer = (state) => writeV4RichTextBatchReports(state, location.reportsDir);
  if (command === "help") {
    process.stdout.write("用法：\n  node src/v4-rich-text-batch-cli.mjs plan\n  node src/v4-rich-text-batch-cli.mjs run --apply [--max-pages 1] [--reset]\n  node src/v4-rich-text-batch-cli.mjs resume --apply [--max-pages 1]\n  node src/v4-rich-text-batch-cli.mjs status\n");
    return;
  }
  if (command === "status") {
    const state = JSON.parse(await readFile(location.statePath, "utf8"));
    await writer(state);
    process.stdout.write(`${JSON.stringify({ ...summarizeV4RichTextBatch(state), stateFile: location.statePath, reportsDir: location.reportsDir }, null, 2)}\n`);
    return;
  }
  if (command === "plan") {
    const state = await loadV4RichTextBatchState(config.paths.v4StateFile, location.statePath, args.reset === true);
    await writer(state);
    process.stdout.write(`${JSON.stringify({ ...summarizeV4RichTextBatch(state), excluded: state.excluded_completed_page, pagesByCategory: Object.groupBy(state.pages, (page) => page.category) }, (key, value) => key === "pagesByCategory" ? Object.fromEntries(Object.entries(value).map(([category, pages]) => [category, pages.length])) : value, 2)}\n`);
    return;
  }
  if (["run", "resume"].includes(command)) {
    if (!args.apply) throw new Error(`${command}会修改4.0编辑器，必须显式传入--apply`);
    const state = await runV4RichTextBatch({ config, ...location, reportsWriter: writer, maxPages: maxPages(args["max-pages"]), reset: args.reset === true });
    process.stdout.write(`${JSON.stringify({ ...summarizeV4RichTextBatch(state), stateFile: location.statePath, reportsDir: location.reportsDir }, null, 2)}\n`);
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

