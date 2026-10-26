#!/usr/bin/env node
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { runV4GrowthEngine } from "./growth-engine-h-v4-run.mjs";
import { loadV4GrowthEnginePages } from "./growth-engine-h-v4-source.mjs";
import {
  buildV4GrowthEngineBatchTasks,
  createV4GrowthEngineBatchState,
  fileExists,
  makeV4BatchPageConfig,
  reconcileRecordedV4Backfill,
  selectV4GrowthEngineBatchTasks,
  summarizeV4PageState,
  updateV4BatchTask,
  V4GrowthEngineBatchStore,
  writeV4GrowthEngineBatchReports,
} from "./growth-engine-h-v4-batch.mjs";
import { GrowthEngineStateStore } from "./growth-engine-h-state.mjs";

function parseArgs(argv) {
  const result = {
    command: argv[2] ?? "status",
    config: "config/growth-engine-h-v4.json",
    apply: false,
    taskId: "",
    startTaskId: "",
    maxPages: Number.POSITIVE_INFINITY,
  };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--task-id") result.taskId = argv[++index];
    else if (argv[index] === "--start-task-id") result.startTaskId = argv[++index];
    else if (argv[index] === "--max-pages") result.maxPages = Number(argv[++index]);
  }
  if (!(result.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return result;
}

async function discover(config, args) {
  const pages = await loadV4GrowthEnginePages(config);
  const allTasks = buildV4GrowthEngineBatchTasks(pages, {
    excludePaths: [config.targetPagePath],
  });
  return selectV4GrowthEngineBatchTasks(allTasks, args);
}

async function plan(config, args) {
  const tasks = await discover(config, args);
  for (const task of tasks) {
    console.log(`${task.id} ${task.page_name} ${task.page_path} H=${task.target_count} 不支持=${task.unsupported_count}`);
  }
  console.log(JSON.stringify({
    pages: tasks.length,
    headings: tasks.reduce((sum, task) => sum + task.target_count, 0),
    unsupported: tasks.reduce((sum, task) => sum + task.unsupported_count, 0),
  }, null, 2));
}

function terminalTask(task) {
  return ["complete", "completed_with_issues", "unverifiable_page"].includes(task.status);
}

async function execute(config, args, { resume = false } = {}) {
  if (!args.apply) throw new Error("4.0增长引擎批量同步会修改外部数据，必须显式包含--apply");
  const store = new V4GrowthEngineBatchStore(config.v4Batch.stateFile);
  let state = resume ? await store.load() : null;
  if (resume && !state) throw new Error("没有可恢复的4.0增长引擎批量状态");
  if (!state) {
    const tasks = await discover(config, args);
    state = createV4GrowthEngineBatchState(tasks);
  }
  state.phase = "running";
  await store.save(state);
  await writeV4GrowthEngineBatchReports(state, config);
  for (const task of state.tasks) {
    if (terminalTask(task)) continue;
    const pageConfig = makeV4BatchPageConfig(config, state, task);
    task.started_at ||= new Date().toISOString();
    task.status = "running";
    task.failure_reason = "";
    await store.save(state);
    console.log(`\n[4.0批量] 开始 ${task.id} ${task.page_name} ${task.page_path}，目标H=${task.target_count}`);
    try {
      const existing = await fileExists(pageConfig.paths.stateFile);
      const pageState = await runV4GrowthEngine(pageConfig, { resume: resume && existing });
      updateV4BatchTask(task, pageState);
      console.log(`[4.0批量] 完成 ${task.id} 状态=${task.status} 问题=${task.issue_count} 只读=${task.non_editable_count} 预览=${task.preview_failure_count} 回填=${task.backfill_error_count}`);
    } catch (error) {
      const pageState = await new GrowthEngineStateStore(pageConfig.paths.stateFile).load().catch(() => null);
      if (pageState) updateV4BatchTask(task, pageState);
      task.status = /login_expired|重新登录/u.test(error.message)
        ? "login_expired"
        : /^page_(?:not_found|detail_unavailable):/u.test(error.message)
          ? "unverifiable_page"
          : "automation_failed";
      task.failure_reason ||= error.message;
      console.error(`[4.0批量] ${task.id} 自动化异常：${error.message}`);
      if (task.status === "login_expired") {
        state.phase = "login_expired";
        await store.save(state);
        await writeV4GrowthEngineBatchReports(state, config);
        throw error;
      }
    }
    await store.save(state);
    await writeV4GrowthEngineBatchReports(state, config);
  }
  const pending = state.tasks.filter((task) => !terminalTask(task));
  state.phase = pending.length === 0
    ? state.tasks.some((task) => task.status !== "complete") ? "completed_with_issues" : "complete"
    : "completed_with_failures";
  await store.save(state);
  const report = await writeV4GrowthEngineBatchReports(state, config);
  console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, ...report }, null, 2));
  return state;
}

async function status(config) {
  const store = new V4GrowthEngineBatchStore(config.v4Batch.stateFile);
  const state = await store.load();
  if (!state) {
    console.log("尚无4.0增长引擎批量状态");
    return;
  }
  for (const task of state.tasks) {
    if (task.page_state_file && await fileExists(task.page_state_file)) {
      const pageState = await new GrowthEngineStateStore(task.page_state_file).load();
      Object.assign(task, summarizeV4PageState(pageState));
    }
  }
  console.log(JSON.stringify({
    run_id: state.run_id,
    phase: state.phase,
    pages: state.tasks.length,
    complete: state.tasks.filter((task) => task.status === "complete").length,
    completed_with_issues: state.tasks.filter((task) => task.status === "completed_with_issues").length,
    unverifiable_pages: state.tasks.filter((task) => task.status === "unverifiable_page").length,
    pending: state.tasks.filter((task) => !terminalTask(task)).length,
    tasks: state.tasks.map((task) => ({
      id: task.id, page: task.page_name, path: task.page_path, status: task.status,
      targets: task.target_count, issues: task.issue_count, non_editable: task.non_editable_count,
      preview: task.preview_status, backfill: task.editor_backfill_status,
    })),
  }, null, 2));
}

async function reconcile(config) {
  const store = new V4GrowthEngineBatchStore(config.v4Batch.stateFile);
  const state = await store.load();
  if (!state) throw new Error("尚无4.0增长引擎批量状态");
  for (const task of state.tasks) {
    if (!task.page_state_file || !await fileExists(task.page_state_file)) continue;
    const pageStore = new GrowthEngineStateStore(task.page_state_file);
    const pageState = await pageStore.load();
    if (reconcileRecordedV4Backfill(pageState) > 0) await pageStore.save(pageState);
    updateV4BatchTask(task, pageState);
  }
  const pending = state.tasks.filter((task) => !terminalTask(task));
  state.phase = pending.length === 0
    ? state.tasks.some((task) => task.status !== "complete") ? "completed_with_issues" : "complete"
    : "completed_with_failures";
  await store.save(state);
  console.log(JSON.stringify(await writeV4GrowthEngineBatchReports(state, config), null, 2));
}

const args = parseArgs(process.argv);
const config = await loadGrowthEngineConfig(args.config);
if (args.command === "plan") await plan(config, args);
else if (args.command === "run") await execute(config, args);
else if (args.command === "resume") await execute(config, args, { resume: true });
else if (args.command === "status") await status(config);
else if (args.command === "reconcile") await reconcile(config);
else if (args.command === "report") {
  const state = await new V4GrowthEngineBatchStore(config.v4Batch.stateFile).load();
  if (!state) throw new Error("尚无4.0增长引擎批量状态");
  console.log(JSON.stringify(await writeV4GrowthEngineBatchReports(state, config), null, 2));
} else throw new Error(`未知命令：${args.command}`);
