#!/usr/bin/env node
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { writeV4GrowthEngineReports } from "./growth-engine-h-v4-report.mjs";
import { inspectV4GrowthEngine, runV4GrowthEngine } from "./growth-engine-h-v4-run.mjs";
import { GrowthEngineStateStore } from "./growth-engine-h-state.mjs";

function parseArgs(argv) {
  const result = { command: argv[2] ?? "status", apply: false, config: "config/growth-engine-h-v4.json" };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--config") result.config = argv[++index];
  }
  return result;
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  try {
    // The login host may redirect between HTTP/HTTPS or to the SSO host. In a
    // headed auth session Playwright can report that redirect as ERR_ABORTED
    // even though the browser has already reached the login page. Waiting for
    // commit is sufficient here; the user completes the visual login.
    await page.goto(config.loginUrl, { waitUntil: "commit", timeout: config.timeouts.navigationMs });
  } catch (error) {
    if (!/ERR_ABORTED|NS_BINDING_ABORTED/u.test(error.message)) throw error;
  }
  console.log("已打开4.0增长引擎认证浏览器，请完成登录后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function status(config) {
  const state = await new GrowthEngineStateStore(config.paths.stateFile).load();
  if (!state) {
    console.log("尚无4.0增长引擎H标签状态");
    return;
  }
  console.log(JSON.stringify({
    run_id: state.run_id,
    page: state.page_name,
    path: state.page_path,
    phase: state.phase,
    initial_refresh: state.initial_refresh,
    preview: state.page_verification,
    editor_backfill: state.editor_backfill_verification,
    counts: state.items.reduce((counts, item) => {
      counts[item.verification_status] = (counts[item.verification_status] ?? 0) + 1;
      return counts;
    }, {}),
  }, null, 2));
}

const args = parseArgs(process.argv);
const config = await loadGrowthEngineConfig(args.config);
if (args.command === "auth") await auth(config);
else if (args.command === "plan") {
  const result = await inspectV4GrowthEngine(config);
  console.log(JSON.stringify({
    page: result.sourcePage.name,
    path: result.sourcePage.path,
    scan: result.scan,
    preview: {
      source: result.preview.source,
      status: result.preview.status,
      error: result.preview.error ?? "",
      skipped: Boolean(result.preview.skipped),
    },
    targets: result.items.length,
    unsupported: result.unsupported.length,
    growth_engine_items: result.controls.length,
    preview_items: result.preview.headings?.length ?? 0,
    mappings: result.mappings.map((mapping, index) => ({
      item_index: index + 1,
      block_id: result.items[index].block_id,
      field_name: result.items[index].field_name,
      status: mapping.status,
      readonly_copies: mapping.readonlyCopies ?? 0,
      reason: mapping.reason ?? "",
    })),
  }, null, 2));
} else if (["run", "resume"].includes(args.command)) {
  if (!args.apply) throw new Error("4.0增长引擎同步会修改外部数据，必须显式包含--apply");
  const state = await runV4GrowthEngine(config, { resume: args.command === "resume" });
  console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, reports: config.paths.reportsDir }, null, 2));
} else if (args.command === "status") await status(config);
else if (args.command === "report") {
  const state = await new GrowthEngineStateStore(config.paths.stateFile).load();
  if (!state) throw new Error("尚无可生成报告的4.0增长引擎状态");
  console.log(JSON.stringify(await writeV4GrowthEngineReports(state, config.paths.reportsDir), null, 2));
} else throw new Error(`未知命令：${args.command}`);
