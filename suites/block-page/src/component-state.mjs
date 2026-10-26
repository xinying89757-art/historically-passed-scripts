import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const COMPONENT_FINAL_STATUSES = new Set([
  "configured",
  "skipped_detail",
  "skipped_h_unsupported",
  "component_not_found",
  "locator_ambiguous",
  "add_failed",
  "render_failed",
  "settings_not_found",
  "title_control_not_found",
  "level_control_not_found",
  "component_save_failed",
  "page_save_failed",
]);

export function createInitialComponentState(input, config) {
  const now = new Date().toISOString();
  return {
    version: 1,
    task: "component-heading",
    created_at: now,
    updated_at: now,
    input_checksum: input.checksum,
    input_workbook: config.componentWorkbook,
    input_sheet: config.componentSheetName,
    components_per_page: config.componentsPerPage,
    next_target_sequence: 1,
    next_page_number: 1,
    current_page: null,
    pages: [],
    records: input.records.map((record) => ({
      ...record,
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
      status: record.initial_status,
      failure_reason:
        record.initial_status === "skipped_detail"
          ? "详情组件本批次暂缓"
          : record.initial_status === "skipped_h_unsupported"
            ? "清单 H 标签列标注 /，本期不支持"
            : "",
      attempt_count: 0,
      component_saved_at: "",
      page_saved_at: "",
      screenshot: "",
      audit: null,
    })),
  };
}

export class ComponentStateStore {
  constructor(stateFile) {
    this.stateFile = stateFile;
  }

  async load() {
    try {
      return JSON.parse(await readFile(this.stateFile, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") {
        return null;
      }
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

  async loadOrCreate(input, config) {
    const existing = await this.load();
    if (!existing) {
      const created = createInitialComponentState(input, config);
      await this.save(created);
      return created;
    }
    if (existing.input_checksum !== input.checksum) {
      throw new Error("组件工作簿已变化，拒绝复用旧状态文件");
    }
    if (existing.components_per_page !== config.componentsPerPage) {
      throw new Error("componentsPerPage 与已有组件状态不一致");
    }
    const inputByName = new Map(
      input.records.map((record) => [record.original_name, record]),
    );
    for (const record of existing.records) {
      const source = inputByName.get(record.original_name);
      if (!source) {
        continue;
      }
      for (const field of [
        "component_kind",
        "expected_title",
        "expected_level",
        "expected_code",
        "expected_headings",
        "expected_editors",
        "expected_tab_title",
        "expected_heading_count",
        "required_tokens",
        "end_date_strategy",
      ]) {
        record[field] = source[field];
      }
      record.actual_code ??= "";
      record.actual_headings ??= [];
      record.actual_editors ??= [];
      record.actual_tokens ??= [];
      record.heading_count ??= 0;
      record.end_date ??= "";
    }
    return existing;
  }
}

export function summarizeComponentState(state) {
  const statuses = {};
  for (const record of state.records) {
    statuses[record.status] = (statuses[record.status] ?? 0) + 1;
  }
  return {
    total: state.records.length,
    pages: state.pages.length,
    statuses,
    nextTargetSequence: state.next_target_sequence,
    currentPage: state.current_page?.name ?? "",
  };
}

export function resetRetryableComponentFailures(state) {
  return resetComponentFailuresByStatuses(state, [
    "component_not_found",
    "locator_ambiguous",
    "add_failed",
    "render_failed",
    "settings_not_found",
    "title_control_not_found",
    "level_control_not_found",
    "component_save_failed",
  ]);
}

export function resetComponentFailuresByStatuses(state, statuses) {
  const retryable = new Set(statuses);
  const reset = [];
  for (const record of state.records) {
    if (!retryable.has(record.status) || record.setting_id) {
      continue;
    }
    record.status = "pending";
    record.failure_reason = "";
    record.screenshot = "";
    record.audit = null;
    reset.push(record.sequence);
  }
  if (reset.length > 0) {
    state.next_target_sequence = Math.min(...reset);
  }
  return reset;
}

export function resetComponentFailuresByNames(state, names) {
  const selected = new Set(names);
  const reset = [];
  for (const record of state.records) {
    if (
      !selected.has(record.original_name) ||
      record.setting_id ||
      [
        "configured",
        "pending",
        "staged",
        "skipped_detail",
        "skipped_h_unsupported",
      ].includes(record.status)
    ) {
      continue;
    }
    Object.assign(record, {
      status: "pending",
      failure_reason: "",
      screenshot: "",
      audit: null,
      actual_title: "",
      actual_level: "",
      actual_code: "",
      actual_headings: [],
      actual_editors: [],
      actual_tokens: [],
      heading_count: 0,
      end_date: "",
    });
    reset.push(record.sequence);
  }
  if (reset.length > 0) {
    state.next_target_sequence = Math.min(...reset);
  }
  return reset;
}

export function reopenLastComponentPageForAppend(state) {
  if (state.current_page || state.pages.length === 0) {
    return null;
  }
  const last = state.pages.at(-1);
  if (
    !last ||
    last.setting_ids.length >= state.components_per_page
  ) {
    return null;
  }
  state.pages.pop();
  const {
    saved_at: _savedAt,
    verified_at: _verifiedAt,
    ...current
  } = last;
  state.current_page = current;
  state.next_page_number = Number(last.number);
  return current;
}
