#!/usr/bin/env node
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { parseCliArgs } from './cli-args.mjs';
import { LeadongEditor, launchEditorBrowser } from './editor.mjs';
import { readRegressionJson, writeRegressionJson } from './ai-regression-state.mjs';
import { runRetryTarget } from './ai-item-retry.mjs';
import { readRetrySource, retryItemFromState } from './ai-retry-targets.mjs';

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (!options.apply || !options['task-file']) throw new Error('精准重试必须提供 --apply 和 --task-file');
  const config = await loadConfig(options.config || 'config/run.json');
  const taskFile = path.resolve(options['task-file']);
  const runs = path.join(config.paths.aiLifecycleDir, 'runs');
  const relative = path.relative(runs, taskFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('精准重试任务不在运行目录内');
  const task = await readRegressionJson(taskFile);
  if (task?.mode !== 'ai-item-retry' || !/^[a-zA-Z0-9_-]{1,80}$/.test(task.run_id || '')) throw new Error('精准重试任务无效');
  if (task.status === 'completed') {
    process.stdout.write(`${JSON.stringify(task.outcome, null, 2)}\n`);
    if (!task.outcome?.ok) process.exitCode = 1;
    return;
  }
  const { context, page } = await launchEditorBrowser(config, { headless: options.headless === true, isolatedProfile: false, slowMo: 0 });
  let outcome;
  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    outcome = await runRetryTarget(editor, config, task, taskFile);
  } catch (error) {
    const stateFile = task.current_state_file || task.item.source_file;
    const state = await readRetrySource(stateFile);
    let screenshot = '';
    if (page.screenshot) {
      screenshot = path.join(path.dirname(taskFile), `failure-${Date.now()}.png`);
      await page.screenshot({ path: screenshot, fullPage: false }).catch(() => { screenshot = ''; });
    }
    const item = retryItemFromState({ ...task.item, source_file: stateFile }, state);
    item.status = 'failed'; item.failure_reason = error.message;
    item.evidence = { ...item.evidence, failure: error.message, screenshot: screenshot || item.evidence?.screenshot };
    outcome = { ok: false, reason: error.message, item, result: { stateFile, runId: task.run_id } };
    task.status = 'completed'; task.outcome = outcome;
    await writeRegressionJson(taskFile, task);
  } finally { await context.close().catch(() => {}); }
  process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  if (!outcome.ok) process.exitCode = 1;
}

main().catch(error => { process.stderr.write(`精准重试失败：${error.message}\n`); process.exitCode = 1; });
