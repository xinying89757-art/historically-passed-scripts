#!/usr/bin/env node
import { access } from "node:fs/promises";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { GrowthEngineStateStore } from "./growth-engine-h-state.mjs";
import { editorCheck as checkEditorPage, run as runPage } from "./growth-engine-h-cli.mjs";
import {
  buildGrowthEngineBatchTasks,
  classifyGrowthEngineBatchError,
  createGrowthEngineBatchState,
  GrowthEngineBatchStore,
  makePageConfig,
  readJson,
  selectGrowthEngineBatchTasks,
  writeGrowthEngineBatchReports,
} from "./growth-engine-h-batch.mjs";

function parseArgs(argv) {
  const result = {
    command: argv[2] ?? "status",
    apply: false,
    config: "config/growth-engine-h.json",
    scope: "all",
    maxPages: Number.POSITIVE_INFINITY,
    taskId: "",
    taskIds: [],
    startTaskId: "",
  };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--scope") result.scope = argv[++index];
    else if (argv[index] === "--max-pages") result.maxPages = Number(argv[++index]);
    else if (argv[index] === "--task-id") result.taskId = argv[++index];
    else if (argv[index] === "--task-ids") {
      result.taskIds = String(argv[++index] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
    }
    else if (argv[index] === "--start-task-id") result.startTaskId = argv[++index];
  }
  if (!["all", "components", "blocks"].includes(result.scope)) {
    throw new Error(`无效范围：${result.scope}`);
  }
  if (!(result.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return result;
}

async function fileExists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function discoverTasks(config, scope) {
  const [componentState, rankingState] = await Promise.all([
    readJson(config.batch.componentStateFile),
    readJson(config.batch.rankingStateFile),
  ]);
  return {
    tasks: buildGrowthEngineBatchTasks({
      componentState,
      rankingState,
      scope,
    }),
  };
}

async function plan(config, args) {
  const discovered = await discoverTasks(config, args.scope);
  const tasks = selectGrowthEngineBatchTasks(discovered.tasks, args);
  for (const task of tasks) {
    console.log(`${task.id} ${task.editor_page_name} -> ${task.target_page_path || "未找到"} [${task.status}]`);
  }
  console.log(`任务：${tasks.length}；可执行：${tasks.filter((task) => task.status === "planned").length}；未找到：${tasks.filter((task) => task.status === "page_not_found").length}`);
}

function updateTaskFromPageState(task, pageState) {
  task.target_page_path = pageState.page_path || task.target_page_path;
  task.growth_engine_item_count = pageState.items?.length ?? 0;
  task.preview_status = pageState.page_verification?.status ?? "pending";
  task.editor_backfill_status = pageState.editor_backfill_verification?.status ?? "pending";
  task.status = pageState.phase;
  task.failure_reason = pageState.run_failure ?? [
    ...(pageState.page_verification?.differences ?? []),
    ...(pageState.editor_backfill_verification?.differences ?? []),
  ].join("；");
  if (pageState.phase === "complete") task.completed_at = new Date().toISOString();
}

async function execute(config, args, { resume = false } = {}) {
  if (!args.apply) throw new Error("批量流程会修改外部数据，必须显式包含 --apply");
  const store = new GrowthEngineBatchStore(config.batch.stateFile);
  let state = resume ? await store.load() : null;
  if (resume && !state) throw new Error("没有可恢复的增长引擎批量状态");
  if (!state) {
    const discovered = await discoverTasks(config, args.scope);
    const tasks = selectGrowthEngineBatchTasks(discovered.tasks, args);
    state = createGrowthEngineBatchState(tasks, {
      scope: args.scope,
      maxPages: Number.POSITIVE_INFINITY,
    });
  }
  state.phase = "running";
  await store.save(state);
  for (const task of state.tasks) {
    if (task.status === "complete" || task.status === "page_not_found") continue;
    const pageConfig = makePageConfig(config, state, task);
    task.started_at ??= new Date().toISOString();
    task.status = "running";
    await store.save(state);
    try {
      const hasPageState = await fileExists(pageConfig.paths.stateFile);
      const pageState = await runPage(pageConfig, { resume: resume && hasPageState });
      updateTaskFromPageState(task, pageState);
    } catch (error) {
      const pageState = await new GrowthEngineStateStore(pageConfig.paths.stateFile).load();
      if (pageState) updateTaskFromPageState(task, pageState);
      else task.status = classifyGrowthEngineBatchError(error.message);
      task.failure_reason ||= error.message;
      if (/login_expired|重新登录/u.test(error.message)) {
        state.phase = "login_expired";
        await store.save(state);
        await writeGrowthEngineBatchReports(state, config.batch.reportsDir);
        throw error;
      }
    }
    await store.save(state);
    await writeGrowthEngineBatchReports(state, config.batch.reportsDir);
  }
  const incomplete = state.tasks.filter((task) => task.status !== "complete");
  state.phase = incomplete.length === 0 ? "complete" : "completed_with_failures";
  await store.save(state);
  const reportDir = await writeGrowthEngineBatchReports(state, config.batch.reportsDir);
  console.log(JSON.stringify({ run_id: state.run_id, phase: state.phase, tasks: state.tasks.map((task) => ({ id: task.id, page: task.editor_page_name, path: task.target_page_path, status: task.status, preview: task.preview_status, editor: task.editor_backfill_status, reason: task.failure_reason })) }, null, 2));
  console.log(reportDir);
}

async function status(config) {
  const state = await new GrowthEngineBatchStore(config.batch.stateFile).load();
  if (!state) {
    console.log("尚无增长引擎批量运行状态");
    return;
  }
  console.log(JSON.stringify({ run_id: state.run_id, scope: state.scope, phase: state.phase, tasks: state.tasks.map((task) => ({ id: task.id, page: task.editor_page_name, path: task.target_page_path, status: task.status, preview: task.preview_status, editor: task.editor_backfill_status, reason: task.failure_reason })) }, null, 2));
}

async function editorCheck(config, args) {
  const store = new GrowthEngineBatchStore(config.batch.stateFile);
  const state = await store.load();
  if (!state) throw new Error("尚无增长引擎批量运行状态");
  const tasks = selectGrowthEngineBatchTasks(state.tasks, args);
  state.phase = "editor_verifying";
  await store.save(state);
  for (const task of tasks) {
    if (!task.page_state_file) continue;
    const pageConfig = makePageConfig(config, state, task);
    await checkEditorPage(pageConfig);
    const pageState = await new GrowthEngineStateStore(pageConfig.paths.stateFile).load();
    updateTaskFromPageState(task, pageState);
    await store.save(state);
    await writeGrowthEngineBatchReports(state, config.batch.reportsDir);
  }
  state.phase = state.tasks.every((task) => task.status === "complete")
    ? "complete"
    : "completed_with_failures";
  await store.save(state);
  const reportDir = await writeGrowthEngineBatchReports(state, config.batch.reportsDir);
  console.log(reportDir);
}

const args = parseArgs(process.argv);
const config = await loadGrowthEngineConfig(args.config);
if (args.command === "plan") await plan(config, args);
else if (args.command === "run") await execute(config, args);
else if (args.command === "resume") await execute(config, args, { resume: true });
else if (args.command === "editor-check") await editorCheck(config, args);
else if (args.command === "status") await status(config);
else throw new Error(`未知命令：${args.command}`);
