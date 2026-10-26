import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  makeExpectedText,
  nextHeadingLevel,
  numericRunId,
  resolveSourceText,
} from "./growth-engine-h-core.mjs";

export function createGrowthEngineState(
  config,
  inventory,
  baseline,
  runId = numericRunId(),
  previousState = null,
) {
  const now = new Date().toISOString();
  return {
    version: 3,
    run_id: runId,
    page_path: config.targetPagePath,
    public_url: config.publicUrl,
    preview_url: "",
    preview_source: "",
    preview_resolution_status: "pending",
    preview_http_status: 0,
    preview_verified_at: "",
    scan_wait_status: "pending",
    created_at: now,
    updated_at: now,
    phase: "planned",
    baseline_live_headings: baseline,
    refreshed_engine_headings: [],
    final_live_headings: [],
    page_verification: {
      status: "pending",
      differences: [],
    },
    editor_backfill_verification: {
      status: config.editorBackfill?.enabled ? "pending" : "disabled",
      page_name: config.editorBackfill?.pageName ?? "",
      verified: 0,
      failed: 0,
      differences: [],
    },
    items: inventory.map((item, index) => {
      const itemIndex = index + 1;
      const previousItem = previousState?.page_path === config.targetPagePath
        ? previousState.items?.[index]
        : null;
      const sourceText = resolveSourceText({ currentText: item.text, previousItem });
      return {
        run_id: runId,
        page_path: config.targetPagePath,
        item_index: itemIndex,
        original_level: item.level,
        original_text: item.text,
        source_text: sourceText,
        level_editable: Boolean(item.levelEditable),
        text_editable: Boolean(item.textEditable),
        expected_level: item.levelEditable ? nextHeadingLevel(item.level) : item.level,
        expected_text: item.textEditable
          ? makeExpectedText({
              sourceText,
              pagePath: config.targetPagePath,
              itemIndex,
              runId,
            })
          : item.text,
        requested_level: item.levelEditable ? nextHeadingLevel(item.level) : item.level,
        requested_text: item.textEditable
          ? makeExpectedText({
              sourceText,
              pagePath: config.targetPagePath,
              itemIndex,
              runId,
            })
          : item.text,
        level_edit_status: item.levelEditable ? "pending" : "field_not_editable",
        text_edit_status: item.textEditable ? "pending" : "field_not_editable",
        edit_failure_reason: "",
        save_status: "pending",
        sync_status: "pending",
        live_level: "",
        live_text: "",
        verification_status: "pending",
        failure_reason: item.unsupportedReason ?? "",
        editor_page_name: config.editorBackfill?.pageName ?? "",
        editor_element_type: "",
        editor_setting_id: "",
        editor_canvas_level: "",
        editor_actual_level: "",
        editor_actual_text: "",
        editor_backfill_status: config.editorBackfill?.enabled
          ? "pending"
          : "disabled",
        editor_backfill_evidence: "",
        editor_backfill_failure_reason: "",
      };
    }),
  };
}

export function migrateGrowthEngineState(state) {
  if (!state) return state;
  state.version = Math.max(Number(state.version) || 1, 3);
  state.editor_backfill_verification ??= {
    status: "pending",
    page_name: "",
    verified: 0,
    failed: 0,
    differences: [],
  };
  state.preview_url ??= state.public_url ?? "";
  state.preview_source ??= state.preview_url ? "legacy_recorded" : "";
  state.preview_resolution_status ??= state.preview_url ? "legacy" : "pending";
  state.preview_http_status ??= 0;
  state.preview_verified_at ??= "";
  state.scan_wait_status ??= "pending";
  for (const item of state.items ?? []) {
    item.source_text ??= item.original_text ?? "";
    item.requested_level ??= item.expected_level ?? item.original_level ?? "";
    item.requested_text ??= item.expected_text ?? item.original_text ?? "";
    item.level_edit_status ??= item.level_editable ? "pending" : "field_not_editable";
    item.text_edit_status ??= item.text_editable ? "pending" : "field_not_editable";
    item.edit_failure_reason ??= "";
    item.editor_page_name ??= state.editor_backfill_verification.page_name ?? "";
    item.editor_element_type ??= "";
    item.editor_setting_id ??= "";
    item.editor_canvas_level ??= "";
    item.editor_actual_level ??= "";
    item.editor_actual_text ??= "";
    item.editor_backfill_status ??= "pending";
    item.editor_backfill_evidence ??= "";
    item.editor_backfill_failure_reason ??= "";
  }
  return state;
}

export class GrowthEngineStateStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
  }

  async load() {
    try {
      return migrateGrowthEngineState(
        JSON.parse(await readFile(this.stateFile, "utf8")),
      );
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  async save(state) {
    state.updated_at = new Date().toISOString();
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.stateFile);
  }
}
