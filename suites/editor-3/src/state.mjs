import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const FINAL_STATUSES = new Set([
  "added",
  "deferred_detail",
  "not_found",
  "locator_ambiguous",
  "add_failed",
  "render_failed",
  "save_failed",
  "published_verified",
]);

export function createInitialState(input, config) {
  return {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    input_checksum: input.checksum,
    input_csv: config.inputCsv,
    blocks_per_page: config.blocksPerPage,
    next_csv_index: 0,
    next_page_number: 1,
    current_page: null,
    pages: [],
    published: false,
    records: input.blocks.map((block) => ({
      ...block,
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      h1_count: 0,
      h2_count: 0,
      h3_count: 0,
      h4_count: 0,
      h5_count: 0,
      h6_count: 0,
      image_count: 0,
      image_urls: [],
      status: "pending",
      failure_reason: "",
      attempt_count: 0,
      saved_at: "",
      published: false,
      audit: null,
    })),
  };
}

export class StateStore {
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
    const tempFile = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(tempFile, this.stateFile);
  }

  async loadOrCreate(input, config) {
    const existing = await this.load();
    if (!existing) {
      const state = createInitialState(input, config);
      await this.save(state);
      return state;
    }
    if (existing.input_checksum !== input.checksum) {
      throw new Error(
        "CSV 内容已变化，拒绝复用旧状态。请先备份 reports 和 .state，再使用新的状态文件。",
      );
    }
    if (existing.blocks_per_page !== config.blocksPerPage) {
      throw new Error("blocksPerPage 与已有运行状态不一致，拒绝恢复");
    }
    return existing;
  }
}

export function assertStateComplete(state) {
  const unfinished = state.records.filter(
    (record) => !FINAL_STATUSES.has(record.status),
  );
  if (unfinished.length > 0) {
    throw new Error(`还有 ${unfinished.length} 个区块未完成分类，不能发布`);
  }
  const unconfirmed = state.records.filter(
    (record) => record.status === "staged",
  );
  if (unconfirmed.length > 0 || state.current_page) {
    throw new Error("仍有未确认保存的页面，不能发布");
  }
}

export function resetStagedFromIndex(state, index) {
  for (let cursor = index; cursor < state.records.length; cursor += 1) {
    if (state.records[cursor].status === "staged") {
      Object.assign(state.records[cursor], {
        page_name: "",
        page_url: "",
        slot_index: "",
        editor_dom_id: "",
        h1_count: 0,
        h2_count: 0,
        h3_count: 0,
        h4_count: 0,
        h5_count: 0,
        h6_count: 0,
        image_count: 0,
        image_urls: [],
        status: "pending",
        failure_reason: "",
        saved_at: "",
        audit: null,
      });
    }
  }
  state.next_csv_index = Math.min(state.next_csv_index, index);
}

export function resetBlockForRetry(state, blockId) {
  const index = state.records.findIndex(
    (record) => String(record.block_id) === String(blockId),
  );
  if (index < 0) {
    throw new Error(`状态文件中不存在区块 ${blockId}`);
  }
  const record = state.records[index];
  if (record.status === "added" || record.status === "published_verified") {
    throw new Error(`区块 ${blockId} 已经添加成功，拒绝重复添加`);
  }
  Object.assign(record, {
    page_name: "",
    page_url: "",
    slot_index: "",
    editor_dom_id: "",
    h1_count: 0,
    h2_count: 0,
    h3_count: 0,
    h4_count: 0,
    h5_count: 0,
    h6_count: 0,
    image_count: 0,
    image_urls: [],
    status: "pending",
    failure_reason: "",
    attempt_count: 0,
    saved_at: "",
    published: false,
    audit: null,
    heading_results: [],
    heading_failure_reason: "",
    heading_verified_at: "",
    heading_status: "",
  });
  state.next_csv_index = Math.min(state.next_csv_index, index);
  return record;
}
