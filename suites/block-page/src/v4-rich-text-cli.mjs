#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, projectRoot } from "./config.mjs";
import { loadV4RichTextSource, loadOrCreateV4RichTextState, runV4RichTextSetup } from "./v4-rich-text-setup.mjs";
import { writeV4RichTextReports } from "./v4-rich-text-report.mjs";

function options(argv) {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) result._.push(token);
    else result[token.slice(2)] = true;
  }
  return result;
}

function locations(config) {
  const settings = config.v4RichText ?? {};
  return {
    statePath: path.resolve(projectRoot, settings.stateFile ?? ".state/v4-rich-text-setup-state.json"),
    artifactsDir: path.resolve(projectRoot, settings.artifactsDir ?? "artifacts/v4-rich-text-setup"),
    reportsDir: path.resolve(projectRoot, settings.reportsDir ?? "reports/v4-rich-text-setup"),
  };
}

function summary(state, paths) {
  const counts = {};
  for (const record of state.records) counts[record.status] = (counts[record.status] ?? 0) + 1;
  return {
    page: state.page_name,
    blocks: state.records.length,
    richTexts: state.records.reduce((sum, record) => sum + record.rich_text_count, 0),
    verifiedRichTexts: state.records.reduce((sum, record) => sum + record.verified_count, 0),
    counts,
    growthEngine: state.growth_engine_status,
    stateFile: paths.statePath,
    reportsDir: paths.reportsDir,
  };
}

async function main() {
  const parsed = options(process.argv.slice(2));
  const command = parsed._[0] ?? "help";
  const config = await loadConfig("config/v4-blocks.json");
  const paths = locations(config);
  const writer = (state) => writeV4RichTextReports(state, paths.reportsDir);
  if (command === "help") {
    process.stdout.write("用法：\n  node src/v4-rich-text-cli.mjs inventory\n  node src/v4-rich-text-cli.mjs prepare --apply [--reset]\n  node src/v4-rich-text-cli.mjs resume --apply\n  node src/v4-rich-text-cli.mjs status\n  node src/v4-rich-text-cli.mjs report\n");
    return;
  }
  if (command === "status" || command === "report") {
    const state = JSON.parse(await readFile(paths.statePath, "utf8"));
    await writer(state);
    process.stdout.write(`${JSON.stringify(summary(state, paths), null, 2)}\n`);
    return;
  }
  if (command === "inventory") {
    const source = await loadV4RichTextSource(config);
    const state = await loadOrCreateV4RichTextState(paths.statePath, source, parsed.reset === true);
    await writer(state);
    process.stdout.write(`${JSON.stringify(summary(state, paths), null, 2)}\n`);
    return;
  }
  if (["prepare", "resume"].includes(command)) {
    if (!parsed.apply) throw new Error(`${command}会修改4.0编辑器，必须显式传入 --apply`);
    const state = await runV4RichTextSetup({ config, ...paths, apply: true, reset: parsed.reset === true, reportWriter: writer });
    process.stdout.write(`${JSON.stringify(summary(state, paths), null, 2)}\n`);
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});

