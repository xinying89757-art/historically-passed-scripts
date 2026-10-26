#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readBlockCsv } from "./csv.mjs";
import {
  CUSTOM_CODE_COMPONENTS,
  RICH_TEXT_DIALOG_COMPONENTS,
  readComponentWorkbook,
} from "./component-input.mjs";
import { writeComponentReports } from "./component-report.mjs";
import {
  relocateComponentToNextPage,
  runComponents,
} from "./component-runner.mjs";
import {
  ComponentStateStore,
  reopenLastComponentPageForAppend,
  resetComponentFailuresByNames,
  resetComponentFailuresByStatuses,
  resetRetryableComponentFailures,
  summarizeComponentState,
} from "./component-state.mjs";
import { loadConfig } from "./config.mjs";
import {
  LeadongEditor,
  launchEditorBrowser,
} from "./editor.mjs";
import { writeReports } from "./report.mjs";
import { readRankingWorkbook } from "./ranking-input.mjs";
import {
  cleanupPreDeferredSavedBlocks,
  preclassifyDeferred,
  provisionBlocks,
  publishAndVerify,
  recoverSavedCurrentPage,
  repairCollapsedPanelFailures,
  repairMissingEnterMisclassification,
  repairSearchTimingFailures,
  summarizeState,
} from "./runner.mjs";
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
    const key = rawKey.replace(/-([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    if (inlineValue !== undefined) {
      options[key] = inlineValue;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      options[key] = argv[index + 1];
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function positiveInteger(value, name) {
  if (value === undefined) {
    return 0;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} 必须是大于 0 的整数`);
  }
  return parsed;
}

function printJson(value) {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandPlan(config, input) {
  const guaranteedDeferred = input.blocks.filter((record) =>
    (config.preDeferredNameKeywords ?? []).some((keyword) =>
      record.app_name.includes(keyword),
    ),
  );
  const candidateCount = input.blocks.length - guaranteedDeferred.length;
  printJson({
    inputCsv: config.inputCsv,
    sourceRows: input.sourceRowCount,
    uniqueBlockIds: input.blocks.length,
    duplicateBlockIds: input.duplicates.length,
    preDeferredByConfirmedKeyword: guaranteedDeferred.length,
    customPageCandidatesBeforeUiCheck: candidateCount,
    blocksPerPage: config.blocksPerPage,
    maximumPagesAfterConfirmedPrefilter: Math.ceil(
      candidateCount / config.blocksPerPage,
    ),
    originalMaximumPages: Math.ceil(
      input.blocks.length / config.blocksPerPage,
    ),
    editorUrl: config.editorUrl,
    publicBaseUrl: config.publicBaseUrl,
  });
  if (input.duplicates.length > 0) {
    printJson({ duplicates: input.duplicates });
  }
}

async function commandAuth(config) {
  const { context, page } = await launchEditorBrowser(config, {
    headless: false,
    slowMo: 0,
  });
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    await page.goto(config.editorUrl, { waitUntil: "domcontentloaded" });
    stdout.write(
      "\n已打开独立 Chrome。请完成登录并确认能看到领动编辑器，再回到终端。\n",
    );
    await terminal.question("完成后按 Enter 保存登录状态并关闭浏览器：");
  } finally {
    terminal.close();
    await context.close();
  }
}

async function commandProbe(config, options) {
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: 0,
  });
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    if (options.openPageMenu) {
      await editor.openPageMenu();
      await page.waitForTimeout(500);
    }
    const probe = await editor.inspect();
    await mkdir(config.paths.artifactsDir, { recursive: true });
    const name = `probe-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}.json`;
    const target = path.join(config.paths.artifactsDir, name);
    await writeFile(target, `${JSON.stringify(probe, null, 2)}\n`, "utf8");
    printJson({
      ok: true,
      artifact: target,
      pageUrl: probe.pageUrl,
      title: probe.title,
      frames: probe.frames.map((frame) => ({
        name: frame.name,
        url: frame.url,
        elementCount: frame.elementCount,
      })),
    });
  } finally {
    await context.close();
  }
}

async function commandStatus(config, input, store) {
  const state = await store.load();
  if (!state) {
    printJson({ initialized: false, message: "尚无运行状态" });
    return;
  }
  if (state.input_checksum !== input.checksum) {
    throw new Error("当前 CSV 与状态文件的校验值不一致");
  }
  await writeReports(state, config.paths.reportsDir);
  printJson({
    initialized: true,
    ...summarizeState(state),
    stateFile: config.paths.stateFile,
    reportsDir: config.paths.reportsDir,
  });
}

async function componentInput(config) {
  return readComponentWorkbook(
    config.componentWorkbook,
    config.componentSheetName,
  );
}

async function commandComponentPlan(config) {
  const input = await componentInput(config);
  printJson({
    workbook: config.componentWorkbook,
    sheet: config.componentSheetName,
    sourceRows: input.sourceRowCount,
    uniqueComponents: input.records.length,
    duplicateComponents: input.duplicates.length,
    targetComponents: input.targetRecords.length,
    skippedDetail: input.counts.skipped_detail ?? 0,
    skippedHUnsupported: input.counts.skipped_h_unsupported ?? 0,
    componentsPerPage: config.componentsPerPage,
    expectedPages: Math.ceil(input.targetRecords.length / config.componentsPerPage),
    firstPage: input.targetRecords.slice(0, config.componentsPerPage).map((record) => ({
      sequence: record.sequence,
      component: record.original_name,
      title: record.expected_title,
      level: record.expected_level,
    })),
    duplicates: input.duplicates,
  });
}

async function commandComponentStatus(config) {
  const input = await componentInput(config);
  const store = new ComponentStateStore(config.paths.componentStateFile);
  const state = await store.load();
  if (!state) {
    printJson({ initialized: false, message: "尚无组件运行状态" });
    return;
  }
  if (state.input_checksum !== input.checksum) {
    throw new Error("当前组件工作簿与状态文件校验值不一致");
  }
  await writeComponentReports(state, config.paths.componentReportsDir);
  printJson({
    initialized: true,
    ...summarizeComponentState(state),
    stateFile: config.paths.componentStateFile,
    reportsDir: config.paths.componentReportsDir,
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const command = options._[0] ?? "help";
  if (["help", "-h"].includes(command) || options.help) {
    stdout.write(`用法：
  node src/cli.mjs plan [--config config/local.json]
  node src/cli.mjs auth
  node src/cli.mjs probe [--open-page-menu]
  node src/cli.mjs run --apply [--max-pages 1] [--max-blocks 6]
  node src/cli.mjs status
  node src/cli.mjs repair-enter-search
  node src/cli.mjs repair-panel-failures
  node src/cli.mjs repair-search-timing
  node src/cli.mjs cleanup-deferred --apply [--max-pages 1]
  node src/cli.mjs recover-save --apply
  node src/cli.mjs publish --apply --confirm-site HOST

组件标题任务：
  node src/cli.mjs component-plan
  node src/cli.mjs component-run --apply [--max-pages 1] [--max-components 6]
  node src/cli.mjs component-resume --apply [--max-pages 1]
  node src/cli.mjs component-status
  node src/cli.mjs component-retry-failures
  node src/cli.mjs component-retry-not-found
  node src/cli.mjs component-retry-custom-code [--reuse-last-page]
  node src/cli.mjs component-retry-rich-text [--reuse-last-page]
  node src/cli.mjs component-relocate-countdown --apply

区块排名H任务：
  node src/cli.mjs ranking-plan --config config/ranking-heading.json
  node src/cli.mjs ranking-status --config config/ranking-heading.json
  node src/cli.mjs ranking-run --apply [--max-pages 1] [--max-blocks 8] --config config/ranking-heading.json
  node src/cli.mjs ranking-resume --apply --config config/ranking-heading.json
  node src/cli.mjs ranking-retry-block --block-id 23274 --config config/ranking-heading.json
`);
    return;
  }

  const config = await loadConfig(options.config);
  if (["ranking-plan", "ranking-status", "ranking-run", "ranking-resume", "ranking-retry-block"].includes(command)) {
    if (!config.rankingWorkbook) {
      throw new Error("ranking 命令必须配置 rankingWorkbook");
    }
    const input = await readRankingWorkbook(
      config.rankingWorkbook,
      config.rankingSheetName ?? "Sheet1",
    );
    const store = new StateStore(config.paths.stateFile);
    if (command === "ranking-plan") {
      const estimatedPages = Math.ceil(input.blocks.length / config.blocksPerPage);
      printJson({
        workbook: input.workbookPath,
        sheet: input.sheetName,
        includedRows: input.includedRows,
        uniqueBlocks: input.blocks.length,
        duplicateBlocks: input.duplicates.length,
        excludedRows: input.excluded.length,
        estimatedPages,
        representatives: input.blocks.slice(0, 8).map((record) => ({
          block_id: record.block_id,
          block_name: record.block_name,
          template_types: record.template_types,
        })),
      });
      return;
    }
    if (command === "ranking-status") {
      const state = await store.load();
      printJson({
        initialized: Boolean(state),
        ...(state ? summarizeState(state) : {}),
        stateFile: config.paths.stateFile,
        reportsDir: config.paths.reportsDir,
      });
      return;
    }
    if (command === "ranking-retry-block") {
      if (!options.blockId) {
        throw new Error("ranking-retry-block 必须传 --block-id");
      }
      const state = await store.load();
      if (!state) {
        throw new Error("排名区块任务尚未初始化");
      }
      const record = resetBlockForRetry(state, options.blockId);
      await store.save(state);
      await writeReports(state, config.paths.reportsDir);
      printJson({
        ok: true,
        resetBlockId: record.block_id,
        status: record.status,
        nextCsvIndex: state.next_csv_index,
      });
      return;
    }
    if (!options.apply) {
      throw new Error(`${command} 会创建并保存页面，必须显式传 --apply`);
    }
    const result = await provisionBlocks({
      config,
      input,
      store,
      maxBlocks: positiveInteger(options.maxBlocks, "--max-blocks"),
      maxPages: positiveInteger(options.maxPages, "--max-pages"),
      headless: options.headless === true,
    });
    printJson({
      ok: true,
      successfullyAddedThisRun: result.successfullyAddedThisRun,
      savedPagesThisRun: result.savedPagesThisRun,
      trace: result.tracePath,
      summary: summarizeState(result.state),
    });
    return;
  }
  if (command === "component-plan") {
    await commandComponentPlan(config);
    return;
  }
  if (command === "component-status") {
    await commandComponentStatus(config);
    return;
  }
  if (command === "component-retry-failures") {
    const input = await componentInput(config);
    const store = new ComponentStateStore(config.paths.componentStateFile);
    const state = await store.loadOrCreate(input, config);
    const resetSequences = resetRetryableComponentFailures(state);
    await store.save(state);
    await writeComponentReports(state, config.paths.componentReportsDir);
    printJson({
      ok: true,
      resetSequences,
      summary: summarizeComponentState(state),
    });
    return;
  }
  if (command === "component-retry-not-found") {
    const input = await componentInput(config);
    const store = new ComponentStateStore(config.paths.componentStateFile);
    const state = await store.loadOrCreate(input, config);
    const resetSequences = resetComponentFailuresByStatuses(state, [
      "component_not_found",
    ]);
    await store.save(state);
    await writeComponentReports(state, config.paths.componentReportsDir);
    printJson({
      ok: true,
      resetSequences,
      summary: summarizeComponentState(state),
    });
    return;
  }
  if (command === "component-retry-custom-code") {
    const input = await componentInput(config);
    const store = new ComponentStateStore(config.paths.componentStateFile);
    const state = await store.loadOrCreate(input, config);
    const resetSequences = resetComponentFailuresByNames(
      state,
      CUSTOM_CODE_COMPONENTS,
    );
    const reusedPage =
      resetSequences.length > 0 && options.reuseLastPage
        ? reopenLastComponentPageForAppend(state)
        : null;
    await store.save(state);
    await writeComponentReports(state, config.paths.componentReportsDir);
    printJson({
      ok: true,
      resetSequences,
      reusedPage: reusedPage?.name ?? "",
      summary: summarizeComponentState(state),
    });
    return;
  }
  if (command === "component-retry-rich-text") {
    const input = await componentInput(config);
    const store = new ComponentStateStore(config.paths.componentStateFile);
    const state = await store.loadOrCreate(input, config);
    const resetSequences = resetComponentFailuresByNames(
      state,
      RICH_TEXT_DIALOG_COMPONENTS,
    );
    const reusedPage =
      resetSequences.length > 0 && options.reuseLastPage
        ? reopenLastComponentPageForAppend(state)
        : null;
    await store.save(state);
    await writeComponentReports(state, config.paths.componentReportsDir);
    printJson({
      ok: true,
      resetSequences,
      reusedPage: reusedPage?.name ?? "",
      summary: summarizeComponentState(state),
    });
    return;
  }
  if (command === "component-relocate-countdown") {
    if (!options.apply) {
      throw new Error("component-relocate-countdown 会删除并重新添加测试倒计时，必须显式传 --apply");
    }
    const input = await componentInput(config);
    const store = new ComponentStateStore(config.paths.componentStateFile);
    const result = await relocateComponentToNextPage({
      config,
      input,
      store,
      componentName: "倒计时",
      headless: options.headless === true,
    });
    printJson({
      ok: true,
      removedSettingId: result.settingId,
      trace: result.tracePath,
      summary: summarizeComponentState(result.state),
    });
    return;
  }
  if (["component-run", "component-resume"].includes(command)) {
    if (!options.apply) {
      throw new Error(`${command} 会创建并保存页面，必须显式传 --apply`);
    }
    const input = await componentInput(config);
    const store = new ComponentStateStore(config.paths.componentStateFile);
    const result = await runComponents({
      config,
      input,
      store,
      maxComponents: positiveInteger(options.maxComponents, "--max-components"),
      maxPages: positiveInteger(options.maxPages, "--max-pages"),
      headless: options.headless === true,
      resume: command === "component-resume",
    });
    printJson({
      ok: true,
      addedThisRun: result.addedThisRun,
      savedPagesThisRun: result.savedPagesThisRun,
      trace: result.tracePath,
      summary: summarizeComponentState(result.state),
    });
    return;
  }
  const input = await readBlockCsv(config.inputCsv);
  const store = new StateStore(config.paths.stateFile);

  if (command === "plan") {
    await commandPlan(config, input);
    return;
  }
  if (command === "auth") {
    await commandAuth(config);
    return;
  }
  if (command === "probe") {
    await commandProbe(config, options);
    return;
  }
  if (command === "status") {
    await commandStatus(config, input, store);
    return;
  }
  if (command === "repair-enter-search") {
    const state = await store.loadOrCreate(input, config);
    const repaired = repairMissingEnterMisclassification(state);
    await store.save(state);
    await writeReports(state, config.paths.reportsDir);
    printJson({
      ok: true,
      repaired,
      ...summarizeState(state),
    });
    return;
  }
  if (command === "repair-panel-failures") {
    const state = await store.loadOrCreate(input, config);
    const repaired = repairCollapsedPanelFailures(state);
    await store.save(state);
    await writeReports(state, config.paths.reportsDir);
    printJson({
      ok: true,
      repaired,
      ...summarizeState(state),
    });
    return;
  }
  if (command === "repair-search-timing") {
    const state = await store.loadOrCreate(input, config);
    const repaired = repairSearchTimingFailures(state);
    await store.save(state);
    await writeReports(state, config.paths.reportsDir);
    printJson({
      ok: true,
      repaired,
      ...summarizeState(state),
    });
    return;
  }
  if (command === "cleanup-deferred") {
    if (!options.apply) {
      throw new Error(
        "cleanup-deferred 会编辑并保存已有测试页，必须显式传 --apply",
      );
    }
    const result = await cleanupPreDeferredSavedBlocks({
      config,
      input,
      store,
      maxPages: positiveInteger(options.maxPages, "--max-pages"),
      headless: options.headless === true,
    });
    printJson({
      ok: true,
      preDeferred: result.preDeferred,
      cleanedPages: result.cleanedPages,
      removedBlocks: result.removedBlocks,
      replacementBlocks: result.replacementBlocks,
      trace: result.tracePath,
      summary: summarizeState(result.state),
    });
    return;
  }
  if (command === "recover-save") {
    if (!options.apply) {
      throw new Error(
        "recover-save 会在重新打开页面核对后提交本地保存状态，必须显式传 --apply",
      );
    }
    const result = await recoverSavedCurrentPage({
      config,
      input,
      store,
      headless: options.headless === true,
    });
    printJson({
      ok: true,
      recoveredBlocks: result.recoveredBlocks,
      trace: result.tracePath,
      summary: summarizeState(result.state),
    });
    return;
  }
  if (command === "run") {
    if (!options.apply) {
      throw new Error("run 会创建并保存页面，必须显式传 --apply");
    }
    const result = await provisionBlocks({
      config,
      input,
      store,
      maxBlocks: positiveInteger(options.maxBlocks, "--max-blocks"),
      maxPages: positiveInteger(options.maxPages, "--max-pages"),
      headless: options.headless === true,
    });
    printJson({
      ok: true,
      preDeferred: result.preDeferred,
      successfullyAddedThisRun: result.successfullyAddedThisRun,
      savedPagesThisRun: result.savedPagesThisRun,
      trace: result.tracePath,
      summary: summarizeState(result.state),
    });
    return;
  }
  if (command === "publish") {
    if (!options.apply) {
      throw new Error("publish 会触发全站发布，必须显式传 --apply");
    }
    const result = await publishAndVerify({
      config,
      input,
      store,
      confirmSite: options.confirmSite,
      headless: options.headless === true,
    });
    printJson({
      ok: true,
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
