#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareHeadingSubset, classifyItemVerification, normalizeText } from "./growth-engine-h-core.mjs";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineStateStore, createGrowthEngineState } from "./growth-engine-h-state.mjs";
import { writeGrowthEngineReports } from "./growth-engine-h-report.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { enterTargetEditor, verifyGrowthEngineEditorBackfill } from "./growth-engine-h-editor-backfill.mjs";
import { LeadongEditor } from "./editor.mjs";
import { loadConfig } from "./config.mjs";

function parseArgs(argv) {
  const result = { command: argv[2] ?? "status", apply: false, config: "config/growth-engine-h.json" };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    if (argv[index] === "--config") result.config = argv[++index];
  }
  return result;
}

function requireApply(args) {
  if (!args.apply) throw new Error("该命令会修改外部数据，必须显式传入 --apply");
}

async function discoverPreviewInEditor(context, config) {
  if (!config.editorBackfill?.enabled) {
    throw new Error("preview_unresolved: 未配置3.0编辑器回退信息");
  }
  const entered = await enterTargetEditor(context, config);
  const editorConfig = await loadConfig();
  editorConfig.siteName = config.editorBackfill.siteName;
  editorConfig.siteLanguage = config.editorBackfill.siteLanguage;
  editorConfig.timeouts.actionMs = config.timeouts.actionMs;
  editorConfig.timeouts.blockRenderMs = config.timeouts.navigationMs;
  const editor = new LeadongEditor(entered.editorPage, editorConfig);
  await editor.openCustomPage(config.editorBackfill.pageName);
  return editor.discoverPreviewUrl(config.targetPagePath);
}

async function readResolvedPreview(editor, config, state = null) {
  const resolution = editor.resolvePreviewUrl(config.targetPagePath, {
    preferDerived: config.previewResolution?.preferDerived ?? true,
    recordedPreviewUrl: state?.preview_url ?? "",
  });
  if (!resolution.url) throw new Error("preview_unresolved: 无法根据站点域名和页面路径生成预览地址");
  try {
    const result = await editor.readPreviewHeadingsAt(resolution.url, { source: resolution.source });
    return { ...result, resolution };
  } catch (error) {
    if (config.previewResolution?.allowEditorFallback === false) throw error;
    const fallbackUrl = await discoverPreviewInEditor(editor.context, config);
    const fallback = await editor.readPreviewHeadingsAt(fallbackUrl, { source: "editor_fallback" });
    return {
      ...fallback,
      resolution: { url: fallbackUrl, source: "editor_fallback", host: new URL(fallbackUrl).hostname, pagePath: config.targetPagePath },
      fallback_reason: error.message,
    };
  }
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开领动登录页。请在浏览器完成登录，确认进入“我的网站”后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function inspect(config) {
  const context = await launchGrowthEngineContext(config);
  try {
    const editor = new GrowthEngineHPage(context, config);
    await editor.open();
    const initialScan = await editor.waitForScanStable();
    const preview = await readResolvedPreview(editor, config);
    const previewUrl = preview.url;
    const live = preview.headings;
    const dialog = await editor.openEditDialog();
    const inventory = await editor.inspectDialog(dialog);
    await editor.cancelDialog(dialog);
    return {
      live,
      previewUrl,
      inventory: inventory.map(({ level, text, levelEditable, textEditable }) => ({
        level, text, levelEditable, textEditable,
      })),
    };
  } finally {
    await context.close();
  }
}

async function plan(config) {
  const result = await inspect(config);
  console.log(`目标页面：${config.targetPagePath}`);
  console.log(`验证地址：${result.previewUrl}`);
  console.log(`增长引擎 H 项：${result.inventory.length}；真实网页 H 项：${result.live.length}`);
  result.inventory.forEach((item, index) => {
    console.log(`${index + 1}. ${item.level} ${item.text}（级别${item.levelEditable ? "可编辑" : "只读"}，文字${item.textEditable ? "可编辑" : "只读"}）`);
  });
  const comparison = compareHeadingSubset(result.inventory, result.live);
  if (!comparison.matches) console.log(`基线差异：\n- ${comparison.differences.join("\n- ")}`);
}

async function pollLive(editor, config, state) {
  const deadline = Date.now() + config.timeouts.liveMs;
  let last = [];
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const preview = await editor.readPreviewHeadingsAt(state.preview_url, {
      source: state.preview_source ?? "derived",
    });
    state.public_url = preview.url;
    state.preview_url = preview.preview_url ?? state.preview_url ?? preview.url;
    state.preview_source = preview.source ?? state.preview_source ?? "derived";
    last = preview.headings;
    const expectedTexts = state.items.filter((item) => item.text_editable).map((item) => normalizeText(item.expected_text));
    const liveTexts = new Set(last.map((item) => normalizeText(item.text)));
    if (expectedTexts.every((text) => liveTexts.has(text))) return last;
    await new Promise((resolve) => setTimeout(resolve, config.timeouts.livePollMs));
  }
  return last;
}

export async function run(config, { resume = false } = {}) {
  const store = new GrowthEngineStateStore(config.paths.stateFile);
  const savedState = await store.load();
  const previousState = resume ? null : savedState;
  let state = resume ? savedState : null;
  if (resume && !state) throw new Error("没有可恢复的增长引擎 H 标签状态");
  await mkdir(config.paths.artifactsDir, { recursive: true });
  const context = await launchGrowthEngineContext(config);
  const tracePath = path.join(config.paths.artifactsDir, "growth-engine-h-trace.zip");
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  let editor;
  try {
    editor = new GrowthEngineHPage(context, config);
    await editor.open();
    const initialScan = await editor.waitForScanStable();
    const initialPreview = await readResolvedPreview(editor, config, state);
    const previewUrl = initialPreview.url;
    const baseline = state
      ? state.baseline_live_headings
      : initialPreview.headings;
    const dialog = await editor.openEditDialog();
    const controls = await editor.inspectDialog(dialog);
    if (!state) {
      const inventory = controls.map(({ level, text, levelEditable, textEditable }) => ({
        level, text, levelEditable, textEditable,
      }));
      const baselineComparison = compareHeadingSubset(inventory, baseline);
      state = createGrowthEngineState(config, inventory, baseline, undefined, previousState);
      state.baseline_comparison = {
        status: baselineComparison.matches ? "matched" : "mismatch_recorded",
        differences: baselineComparison.differences,
        note: baselineComparison.matches
          ? "增长引擎基线与预览页一致"
          : "预览页可能尚未发布或未包含编辑器草稿；差异已记录，不阻断试跑",
      };
      state.public_url = previewUrl;
      state.preview_url = previewUrl;
      state.preview_source = initialPreview.resolution.source;
      state.preview_resolution_status = "verified";
      state.preview_http_status = initialPreview.http_status ?? 200;
      state.preview_verified_at = new Date().toISOString();
      state.scan_wait_status = initialScan.status;
      await store.save(state);
    } else if (controls.length !== state.items.length) {
      await editor.cancelDialog(dialog);
      throw new Error(`locator_ambiguous: 恢复时界面 ${controls.length} 项与状态 ${state.items.length} 项不一致`);
    }
    state.public_url = previewUrl;
    state.preview_url = previewUrl;
    state.preview_source = initialPreview.resolution.source;
    state.preview_resolution_status = "verified";
    state.preview_http_status = initialPreview.http_status ?? 200;
    state.preview_verified_at = new Date().toISOString();
    state.scan_wait_status = initialScan.status;

    const alreadyApplied = controls.every((control, index) =>
      control.level === state.items[index].expected_level &&
      normalizeText(control.text) === normalizeText(state.items[index].expected_text),
    );
    if (!alreadyApplied) {
      state.phase = "editing";
      for (let index = 0; index < controls.length; index += 1) {
        const control = controls[index];
        const item = state.items[index];
        let successfulFields = 0;
        const editFailures = [];
        if (item.level_editable) {
          try {
            await editor.chooseLevel(control, item.requested_level);
            const actualLevel = await editor.readSelectedLevel(control);
            if (actualLevel !== item.requested_level) {
              throw new Error(`edit_not_effective: 级别应为 ${item.requested_level}，界面仍为 ${actualLevel}`);
            }
            item.expected_level = actualLevel;
            item.level_edit_status = "edited";
            successfulFields += 1;
          } catch (error) {
            item.level_edit_status = /edit_not_effective/u.test(error.message)
              ? "edit_not_effective"
              : "edit_failed";
            item.expected_level = item.original_level;
            editFailures.push(`级别：${error.message}`);
          }
        } else {
          item.level_edit_status = "field_not_editable";
        }
        if (item.text_editable) {
          try {
            await control.textInput.fill(item.requested_text);
            const actualText = normalizeText(await control.textInput.inputValue());
            if (actualText !== normalizeText(item.requested_text)) {
              throw new Error(`edit_not_effective: 文字应为“${normalizeText(item.requested_text)}”，界面仍为“${actualText}”`);
            }
            item.expected_text = item.requested_text;
            item.text_edit_status = "edited";
            successfulFields += 1;
          } catch (error) {
            item.text_edit_status = /edit_not_effective/u.test(error.message)
              ? "edit_not_effective"
              : "edit_failed";
            item.expected_text = item.original_text;
            editFailures.push(`文字：${error.message}`);
          }
        } else {
          item.text_edit_status = "field_not_editable";
        }
        item.edit_failure_reason = editFailures.join("；");
        if (!item.level_editable && !item.text_editable) {
          item.save_status = "not_applicable";
          item.sync_status = "not_applicable";
          item.verification_status = "not_editable";
        } else if (successfulFields > 0) {
          item.save_status = "staged";
          if (editFailures.length > 0) {
            item.verification_status = "edit_failed";
            item.failure_reason = item.edit_failure_reason;
          }
        } else {
          item.save_status = "failed";
          item.verification_status = "edit_failed";
          item.failure_reason = item.edit_failure_reason || "所有可编辑字段均修改失败";
        }
        await store.save(state);
      }
      const staged = state.items.filter((item) => item.save_status === "staged");
      if (staged.length > 0) {
        try {
          await editor.saveAndSync(dialog);
          for (const item of staged) {
            item.save_status = "saved";
            item.sync_status = "succeeded";
          }
        } catch (error) {
          for (const item of staged) {
            if (/save_not_available/u.test(error.message)) item.save_status = "save_not_available";
            else if (/save_failed/u.test(error.message)) item.save_status = "save_failed";
            else item.sync_status = "failed";
            item.verification_status = /save_not_available|save_failed/u.test(error.message)
              ? "edit_failed"
              : "sync_failed";
            item.failure_reason = error.message;
          }
          throw error;
        } finally {
          await store.save(state);
        }
      } else {
        await editor.cancelDialog(dialog);
      }
    } else {
      await editor.cancelDialog(dialog);
      for (const item of state.items) {
        if (item.level_editable || item.text_editable) {
          item.save_status = "saved";
          item.sync_status = "succeeded";
        }
      }
      await store.save(state);
    }

    state.phase = "verifying";
    await store.save(state);
    editor = new GrowthEngineHPage(context, config);
    await editor.open();
    const refreshedScan = await editor.waitForScanStable();
    state.scan_wait_status = refreshedScan.status;
    const refreshedDialog = await editor.openEditDialog();
    const refreshedInventory = await editor.inspectDialog(refreshedDialog);
    await editor.cancelDialog(refreshedDialog);
    const refreshed = await readResolvedPreview(editor, config, state);
    state.refreshed_engine_headings = refreshedInventory.map(({ level, text }) => ({ level, text }));
    state.public_url = refreshed.url;
    state.preview_url = refreshed.url;
    state.preview_source = refreshed.resolution.source;
    state.preview_resolution_status = "verified";
    state.preview_http_status = refreshed.http_status ?? 200;
    state.preview_verified_at = new Date().toISOString();
    await store.save(state);
    state.final_live_headings = await pollLive(editor, config, state);
    for (const item of state.items) {
      if (["edit_failed", "sync_failed"].includes(item.verification_status)) continue;
      const result = classifyItemVerification(item, state.final_live_headings);
      Object.assign(item, {
        verification_status: result.status,
        live_level: result.live_level,
        live_text: result.live_text,
        failure_reason: result.failure_reason,
      });
      if (item.text_editable && normalizeText(item.original_text) !== normalizeText(item.expected_text)) {
        const oldCount = state.final_live_headings.filter((heading) => normalizeText(heading.text) === normalizeText(item.original_text)).length;
        if (oldCount > 0 && result.status === "modified_verified") {
          item.verification_status = "live_text_mismatch";
          item.failure_reason = `真实网页仍保留原文字，共 ${oldCount} 处`;
        }
      }
      await store.save(state);
    }
    const fullComparison = compareHeadingSubset(state.refreshed_engine_headings, state.final_live_headings);
    state.page_verification = {
      status: fullComparison.matches ? "verified" : "failed",
      differences: fullComparison.differences,
    };
    await store.save(state);

    state.phase = "editor_verifying";
    await store.save(state);
    await verifyGrowthEngineEditorBackfill({
      context,
      config,
      state,
      persist: async () => store.save(state),
    });

    state.phase = fullComparison.matches &&
    state.editor_backfill_verification?.status === "verified" &&
    state.items.every((item) => [
      "modified_verified", "partially_editable_verified", "not_editable",
    ].includes(item.verification_status)) ? "complete" : "failed";
    if (state.phase === "complete") delete state.run_failure;
    await store.save(state);
  } catch (error) {
    if (state) {
      state.phase = "failed";
      state.run_failure = error.message;
      await store.save(state);
    }
    if (editor) await editor.screenshot(`failure-${Date.now()}.png`).catch(() => {});
    throw error;
  } finally {
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close();
    if (state) await writeGrowthEngineReports(state, config.paths.reportsDir);
  }
  return state;
}

async function status(config) {
  const state = await new GrowthEngineStateStore(config.paths.stateFile).load();
  if (!state) {
    console.log("尚无增长引擎 H 标签运行状态");
    return;
  }
  const counts = state.items.reduce((result, item) => {
    result[item.verification_status] = (result[item.verification_status] ?? 0) + 1;
    return result;
  }, {});
  console.log(JSON.stringify({
    run_id: state.run_id,
    page_path: state.page_path,
    phase: state.phase,
    counts,
    editor_backfill_verification: state.editor_backfill_verification,
    page_verification: state.page_verification,
  }, null, 2));
}

export async function editorCheck(config) {
  const store = new GrowthEngineStateStore(config.paths.stateFile);
  const state = await store.load();
  if (!state) throw new Error("尚无增长引擎 H 标签状态，无法执行编辑器回填检查");
  const context = await launchGrowthEngineContext(config);
  try {
    // Keep the Growth Engine platform page open so the backfill verifier uses
    // the same site switcher and “网页编辑” route as the integrated E2E flow.
    const growthEngine = new GrowthEngineHPage(context, config);
    await growthEngine.open();
    state.phase = "editor_verifying";
    await store.save(state);
    await verifyGrowthEngineEditorBackfill({
      context,
      config,
      state,
      persist: async () => store.save(state),
    });
    const previewVerified = state.page_verification?.status === "verified" &&
      state.items.every((item) => [
        "modified_verified", "partially_editable_verified", "not_editable",
      ].includes(item.verification_status));
    state.phase = state.editor_backfill_verification.status === "verified"
      ? (previewVerified ? "complete" : "editor_verified")
      : "failed";
    await store.save(state);
  } finally {
    await context.close();
    await writeGrowthEngineReports(state, config.paths.reportsDir);
  }
  console.log(JSON.stringify(state.editor_backfill_verification, null, 2));
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadGrowthEngineConfig(args.config);
  if (args.command === "auth") await auth(config);
  else if (args.command === "plan") await plan(config);
  else if (args.command === "run") { requireApply(args); await run(config); }
  else if (args.command === "resume") { requireApply(args); await run(config, { resume: true }); }
  else if (args.command === "status") await status(config);
  else if (args.command === "editor-check") await editorCheck(config);
  else if (args.command === "report") {
    const state = await new GrowthEngineStateStore(config.paths.stateFile).load();
    if (!state) throw new Error("尚无可生成报告的运行状态");
    await writeGrowthEngineReports(state, config.paths.reportsDir);
    console.log(config.paths.reportsDir);
  } else throw new Error(`未知命令：${args.command}`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
