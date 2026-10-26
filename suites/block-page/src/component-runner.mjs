import { mkdir } from "node:fs/promises";
import path from "node:path";
import { componentPageDescriptor } from "./config.mjs";
import { ComponentEditor } from "./component-editor.mjs";
import { writeComponentReports } from "./component-report.mjs";
import {
  LeadongEditor,
  launchEditorBrowser,
  stopTrace,
} from "./editor.mjs";

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function persist(state, store, config) {
  await store.save(state);
  await writeComponentReports(state, config.paths.componentReportsDir);
}

async function screenshot(page, config, label) {
  const directory = path.join(config.paths.componentArtifactsDir, "screenshots");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${timestamp()}-${label}.png`);
  await page.screenshot({ path: target, fullPage: true }).catch(() => {});
  return target;
}

function nextPending(state) {
  return state.records.find((record) => record.status === "pending") ?? null;
}

function pageRecords(state, pageName) {
  return state.records
    .filter(
      (record) =>
        record.page_name === pageName &&
        !["pending", "skipped_detail", "skipped_h_unsupported"].includes(
          record.status,
        ),
    )
    .sort((left, right) => Number(left.slot_index) - Number(right.slot_index));
}

function applyAudit(record, audit) {
  record.actual_title = audit?.actual_title ?? "";
  record.actual_level = audit?.actual_level ?? "";
  record.actual_code = audit?.actual_code ?? "";
  record.actual_headings = audit?.actual_headings ?? [];
  record.actual_editors = audit?.actual_editors ?? [];
  record.actual_tokens = audit?.actual_tokens ?? [];
  record.heading_count = audit?.heading_count ?? 0;
  if (audit?.end_date) {
    record.end_date = audit.end_date;
  }
  record.audit = audit ?? null;
}

async function saveAndVerifyPage(editor, componentEditor, state, store, config) {
  const current = state.current_page;
  if (!current || current.setting_ids.length === 0) {
    return false;
  }

  let saveError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await editor.savePage();
      saveError = null;
      break;
    } catch (error) {
      saveError = error;
      if (attempt === 1) {
        await editor.page.waitForTimeout(1200);
      }
    }
  }
  if (saveError) {
    const shot = await screenshot(
      editor.page,
      config,
      `${current.name}-page-save-failed`,
    );
    for (const record of pageRecords(state, current.name)) {
      record.status = "page_save_failed";
      record.failure_reason = saveError.message;
      record.screenshot = shot;
    }
    await persist(state, store, config);
    throw new Error(`${current.name} 连续两次右上角保存失败：${saveError.message}`);
  }

  const savedAt = new Date().toISOString();
  await editor.openCustomPage(current.name);
  for (const record of pageRecords(state, current.name)) {
    if (!record.setting_id) {
      continue;
    }
    if (record.status === "configured" && record.page_saved_at) {
      continue;
    }
    const audit = await componentEditor.auditRecord(record.setting_id, record);
    applyAudit(record, audit);
    record.page_saved_at = savedAt;
    if (audit.ok) {
      record.status = "configured";
      record.failure_reason = "";
    } else {
      record.status = "component_save_failed";
      record.failure_reason = `重新打开页面验证失败：${audit.reason}`;
      record.screenshot = await screenshot(
        editor.page,
        config,
        `${current.name}-${record.original_name}-verify-failed`,
      );
    }
  }
  state.pages.push({ ...current, saved_at: savedAt, verified_at: new Date().toISOString() });
  state.current_page = null;
  state.next_page_number += 1;
  await persist(state, store, config);
  return true;
}

async function reconcileCurrentPage(editor, componentEditor, state, store, config) {
  if (!state.current_page) {
    return;
  }
  await editor.openCustomPage(state.current_page.name);
  const existing = await componentEditor.listComponents();
  const existingIds = new Set(existing.map((component) => component.setting_id));
  const missing = state.current_page.setting_ids.filter(
    (settingId) => !existingIds.has(settingId),
  );
  if (missing.length > 0) {
    if (missing.length === state.current_page.setting_ids.length) {
      for (const record of pageRecords(state, state.current_page.name)) {
        Object.assign(record, {
          page_name: "",
          page_path: "",
          page_url: "",
          slot_index: "",
          setting_id: "",
          actual_title: "",
          actual_level: "",
          actual_code: "",
          actual_headings: [],
          actual_editors: [],
          actual_tokens: [],
          heading_count: 0,
          end_date: "",
          status: "pending",
          failure_reason: "",
          component_saved_at: "",
          page_saved_at: "",
          screenshot: "",
          audit: null,
        });
      }
      state.current_page.setting_ids = [];
      state.current_page.component_names = [];
      await persist(state, store, config);
      return;
    }
    throw new Error(
      `${state.current_page.name} 恢复对账缺少 settingId：${missing.join(", ")}，为避免重复添加已停止`,
    );
  }
  componentEditor.lastSettingId = state.current_page.setting_ids.at(-1) ?? "";
  for (const record of pageRecords(state, state.current_page.name)) {
    if (record.status === "staged" || record.status === "configured") {
      continue;
    }
    const recovered = await componentEditor.configureExisting(record);
    if (recovered.outcome === "configured") {
      record.status = "staged";
      applyAudit(record, recovered.audit);
      record.failure_reason = "";
      record.component_saved_at = new Date().toISOString();
    }
  }
  await persist(state, store, config);
}

function assignPlacement(record, current, component) {
  const slot = current.setting_ids.length + 1;
  Object.assign(record, {
    page_name: current.name,
    page_path: current.path,
    page_url: current.publicUrl,
    slot_index: slot,
    setting_id: component.setting_id,
  });
  current.setting_ids.push(component.setting_id);
  current.component_names.push(record.original_name);
}

export async function runComponents({
  config,
  input,
  store,
  maxPages = 0,
  maxComponents = 0,
  headless = false,
  resume = false,
}) {
  const state = await store.loadOrCreate(input, config);
  await persist(state, store, config);
  const tracePath = path.join(
    config.paths.componentArtifactsDir,
    "traces",
    `component-${resume ? "resume" : "run"}-${timestamp()}.zip`,
  );
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    slowMo: headless ? 0 : Math.max(config.browser.slowMo, 350),
    traceName: "3.0组件H标签配置",
  });
  const editor = new LeadongEditor(page, config);
  const componentEditor = new ComponentEditor(editor);
  let addedThisRun = 0;
  let savedPagesThisRun = 0;
  let runError;

  try {
    await editor.goto();
    await reconcileCurrentPage(editor, componentEditor, state, store, config);

    while (true) {
      if (maxPages > 0 && savedPagesThisRun >= maxPages) {
        break;
      }
      if (maxComponents > 0 && addedThisRun >= maxComponents) {
        break;
      }
      const record = nextPending(state);
      if (!record) {
        if (state.current_page?.setting_ids.length) {
          if (await saveAndVerifyPage(editor, componentEditor, state, store, config)) {
            savedPagesThisRun += 1;
          }
        }
        break;
      }

      if (!state.current_page) {
        const descriptor = componentPageDescriptor(config, state.next_page_number);
        if (await editor.customPageExists(descriptor.name)) {
          await editor.openCustomPage(descriptor.name);
          const components = await componentEditor.listComponents();
          if (components.length > 0) {
            throw new Error(
              `${descriptor.name} 已存在且含 ${components.length} 个组件，但状态文件没有接管记录`,
            );
          }
        } else {
          await editor.createCustomPage(descriptor);
        }
        state.current_page = {
          ...descriptor,
          setting_ids: [],
          component_names: [],
          created_at: new Date().toISOString(),
        };
        await persist(state, store, config);
      }

      record.attempt_count += 1;
      let result;
      try {
        result = await componentEditor.addAndConfigure(record);
      } catch (error) {
        if (
          page.isClosed() ||
          /Target page, context or browser has been closed/i.test(error.message)
        ) {
          throw error;
        }
        result = {
          outcome: error.status ?? "add_failed",
          reason: error.message,
        };
      }

      if (result.component?.setting_id) {
        assignPlacement(record, state.current_page, result.component);
        applyAudit(record, result.audit);
        record.component_saved_at = new Date().toISOString();
        record.status = result.outcome === "configured" ? "staged" : result.outcome;
        record.failure_reason = result.reason ?? "";
        addedThisRun += 1;
      } else {
        record.status = result.outcome;
        record.failure_reason = result.reason ?? "组件卡片未找到";
        const dialogClosed = await componentEditor.cancelOpenDialog();
        if (!dialogClosed) {
          throw new Error(
            `${record.original_name} 失败后无法安全关闭组件设置弹窗，已停止当前页面`,
          );
        }
        if (!["component_not_found", "locator_ambiguous"].includes(result.outcome)) {
          record.screenshot = await screenshot(
            page,
            config,
            `${state.current_page.name}-${record.original_name}-failed`,
          );
        }
      }
      state.next_target_sequence = record.sequence + 1;
      await persist(state, store, config);

      if (state.current_page.setting_ids.length >= config.componentsPerPage) {
        if (await saveAndVerifyPage(editor, componentEditor, state, store, config)) {
          savedPagesThisRun += 1;
        }
      }
    }

    if (
      state.current_page?.setting_ids.length &&
      (maxComponents > 0 && addedThisRun >= maxComponents) &&
      !(maxPages > 0 && savedPagesThisRun >= maxPages)
    ) {
      if (await saveAndVerifyPage(editor, componentEditor, state, store, config)) {
        savedPagesThisRun += 1;
      }
    }
  } catch (error) {
    runError = error;
    await screenshot(page, config, "run-stopped");
  } finally {
    await persist(state, store, config).catch(() => {});
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }

  if (runError) {
    throw Object.assign(runError, { tracePath });
  }
  return { state, addedThisRun, savedPagesThisRun, tracePath };
}

export async function relocateComponentToNextPage({
  config,
  input,
  store,
  componentName,
  headless = false,
}) {
  const state = await store.loadOrCreate(input, config);
  const record = state.records.find(
    (candidate) => candidate.original_name === componentName,
  );
  if (!record?.setting_id || !record.page_name) {
    throw new Error(`${componentName} 没有可精确定位的已添加记录`);
  }
  const pageIndex = state.pages.findIndex(
    (candidate) => candidate.name === record.page_name,
  );
  if (pageIndex < 0 || pageIndex !== state.pages.length - 1) {
    throw new Error(`${componentName} 只能从最后一个已保存组件页移动`);
  }
  const savedPage = state.pages[pageIndex];
  const settingId = record.setting_id;
  const tracePath = path.join(
    config.paths.componentArtifactsDir,
    "traces",
    `component-relocate-${timestamp()}.zip`,
  );
  const { context, page } = await launchEditorBrowser(config, {
    headless,
    slowMo: headless ? 0 : Math.max(config.browser.slowMo, 350),
    traceName: `移动${componentName}到下一页`,
  });
  const editor = new LeadongEditor(page, config);
  const componentEditor = new ComponentEditor(editor);
  let runError;
  try {
    await editor.goto();
    await editor.openCustomPage(savedPage.name);
    await componentEditor.deleteComponent(settingId);
    await editor.savePage();
    await editor.openCustomPage(savedPage.name);
    const ids = new Set(
      (await componentEditor.listComponents()).map((component) => component.setting_id),
    );
    if (ids.has(settingId)) {
      throw new Error(`重新打开${savedPage.name}后，${settingId}仍然存在`);
    }

    savedPage.setting_ids = savedPage.setting_ids.filter((id) => id !== settingId);
    const componentIndex = savedPage.component_names.lastIndexOf(componentName);
    if (componentIndex >= 0) {
      savedPage.component_names.splice(componentIndex, 1);
    }
    state.pages.splice(pageIndex, 1);
    const { saved_at: _savedAt, verified_at: _verifiedAt, ...currentPage } = savedPage;
    state.current_page = currentPage;
    state.next_page_number = Number(savedPage.number);
    Object.assign(record, {
      page_name: "",
      page_path: "",
      page_url: "",
      slot_index: "",
      setting_id: "",
      actual_title: "",
      actual_level: "",
      actual_code: "",
      actual_headings: [],
      actual_editors: [],
      actual_tokens: [],
      heading_count: 0,
      end_date: "",
      status: "pending",
      failure_reason: "",
      component_saved_at: "",
      page_saved_at: "",
      screenshot: "",
      audit: null,
    });
    state.next_target_sequence = Math.min(state.next_target_sequence, record.sequence);
    await persist(state, store, config);
  } catch (error) {
    runError = error;
    await screenshot(page, config, `relocate-${componentName}-failed`);
  } finally {
    await persist(state, store, config).catch(() => {});
    await stopTrace(context, tracePath).catch(() => {});
    await context.close().catch(() => {});
  }
  if (runError) {
    throw Object.assign(runError, { tracePath });
  }
  return { state, settingId, tracePath };
}
