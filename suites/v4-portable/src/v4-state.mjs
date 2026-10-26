import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function v4PageDescriptor(config, category, number) {
  const rules = config.v4PageDescriptors[category];
  if (!rules) throw new Error(`未配置分类页面规则：${category}`);
  const suffix = String(number).padStart(3, "0");
  const route = `/${rules.pathPrefix}${suffix}`;
  return {
    category,
    number,
    name: `${rules.namePrefix}${suffix}`,
    path: route,
    publicUrl: new URL(route, config.publicBaseUrl).toString(),
  };
}

export function syncV4PublicUrls(state, config) {
  let changed = 0;
  const pages = [...state.pages, ...(state.current_page ? [state.current_page] : [])];
  const byName = new Map();
  for (const page of pages) {
    const expected = new URL(page.path, config.publicBaseUrl).toString();
    if (page.publicUrl !== expected) {
      page.publicUrl = expected;
      changed += 1;
    }
    byName.set(page.name, page);
  }
  for (const record of state.records) {
    if (!record.page_name || !byName.has(record.page_name)) continue;
    const expected = byName.get(record.page_name).publicUrl;
    if (record.page_url !== expected) {
      record.page_url = expected;
      changed += 1;
    }
  }
  return changed;
}

export function configuredV4Targets(input, config) {
  if (config.v4TargetMode === "all") {
    return Object.fromEntries(
      config.v4Categories.map((category) => [
        category,
        input.candidates.filter((candidate) => candidate.category === category).length,
      ]),
    );
  }
  if (config.v4TargetsByCategory) {
    return Object.fromEntries(
      config.v4Categories.map((category) => [category, Number(config.v4TargetsByCategory[category] ?? 0)]),
    );
  }
  return Object.fromEntries(
    config.v4Categories.map((category) => [category, Number(config.v4TargetPerCategory)]),
  );
}

export function v4TargetForCategory(state, category) {
  return Number(state.targets_by_category?.[category] ?? state.target_per_category ?? 0);
}

export function isV4AllMode(state) {
  return state.target_mode === "all";
}

export function createInitialV4State(input, config) {
  const targets = configuredV4Targets(input, config);
  const allMode = config.v4TargetMode === "all";
  return {
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    input_checksum: input.checksum,
    input_csv: input.csvPath,
    categories: [...config.v4Categories],
    target_mode: allMode ? "all" : "fixed",
    targets_by_category: targets,
    target_per_category: allMode ? null : config.v4TargetPerCategory,
    blocks_per_page: config.blocksPerPage,
    pages: [],
    current_page: null,
    published: false,
    records: input.candidates.map((candidate) => ({
      ...candidate,
      status: candidate.candidate_rank <= targets[candidate.category] ? "pending" : "standby",
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      failure_reason: "",
      attempt_count: 0,
      saved_at: "",
      audit: null,
    })),
    excluded: input.excluded,
  };
}

export function mergeV4AllCandidates(state, input, config) {
  if (!isV4AllMode(state) || config.v4TargetMode !== "all") {
    throw new Error("只有4.0全量模式允许合并新增候选");
  }
  const incomingIds = new Set(input.candidates.map((candidate) => String(candidate.block_id)));
  const stale = state.records.filter((record) => !incomingIds.has(String(record.block_id)));
  if (stale.length > 0) {
    throw new Error(`新的4.0候选范围缺少已有 ${stale.length} 条记录，拒绝自动缩小范围`);
  }
  const existingById = new Map(state.records.map((record) => [String(record.block_id), record]));
  let added = 0;
  for (const candidate of input.candidates) {
    const existing = existingById.get(String(candidate.block_id));
    if (existing) {
      Object.assign(existing, {
        csv_row: candidate.csv_row,
        app_name: candidate.app_name,
        description: candidate.description,
        category: candidate.category,
        candidate_rank: candidate.candidate_rank,
      });
      continue;
    }
    state.records.push({
      ...candidate,
      status: "pending",
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      failure_reason: "",
      attempt_count: 0,
      saved_at: "",
      audit: null,
    });
    added += 1;
  }
  state.records.sort((left, right) => {
    const categoryDifference = state.categories.indexOf(left.category) - state.categories.indexOf(right.category);
    return categoryDifference || left.candidate_rank - right.candidate_rank;
  });
  state.targets_by_category = configuredV4Targets(input, config);
  state.excluded = input.excluded;
  state.input_csv = input.csvPath;
  return added;
}

export function categoryProgress(state, category) {
  const records = state.records.filter((record) => record.category === category);
  return {
    added: records.filter((record) => record.status === "added").length,
    staged: records.filter((record) => record.status === "staged").length,
    pending: records.filter((record) => record.status === "pending").length,
    failed: records.filter((record) => ["not_found", "add_failed", "render_failed", "locator_ambiguous"].includes(record.status)).length,
    standby: records.filter((record) => record.status === "standby").length,
    target: v4TargetForCategory(state, category),
    total: records.length,
  };
}

export function ensureV4ReplacementQueue(state, category) {
  if (isV4AllMode(state)) {
    for (const record of state.records) {
      if (record.category === category && record.status === "standby") record.status = "pending";
    }
    return categoryProgress(state, category);
  }
  const target = v4TargetForCategory(state, category);
  let progress = categoryProgress(state, category);
  let needed = target - progress.added - progress.staged - progress.pending;
  while (needed > 0) {
    const next = state.records.find((record) => record.category === category && record.status === "standby");
    if (!next) break;
    next.status = "pending";
    needed -= 1;
  }
  progress = categoryProgress(state, category);
  return progress;
}

export function nextV4Category(state) {
  if (isV4AllMode(state)) {
    return state.categories.find((category) =>
      state.records.some((record) => record.category === category && ["pending", "staged"].includes(record.status)),
    ) ?? "";
  }
  return state.categories.find((category) => categoryProgress(state, category).added < v4TargetForCategory(state, category)) ?? "";
}

export function nextV4PendingRecord(state, category) {
  return state.records.find((record) => record.category === category && record.status === "pending") ?? null;
}

export function repairV4SearchPlaceholderFailures(state) {
  const repairId = "v4-card-click-and-structural-audit-v1";
  state.applied_repairs ??= [];
  if (state.applied_repairs.includes(repairId)) return 0;
  let repaired = 0;
  for (const record of state.records) {
    const selectorFailure = record.status === "add_failed" &&
      (["点击新区块入口后未出现区块搜索框", "点击蓝色加号后未出现区块搜索框"].includes(record.failure_reason) ||
        /结果卡片中未找到“添加”按钮|waiting for getByPlaceholder\('请输入'/.test(record.failure_reason));
    const structuralAuditGap = record.status === "render_failed" &&
      record.audit?.nodeCreated === true &&
      /^添加后60秒内未能唯一确认区块/.test(record.failure_reason);
    const interruptedBeforeSearch = record.status === "pending" &&
      record.attempt_count > 0 &&
      record.page_name === state.current_page?.name &&
      !state.current_page.block_ids.includes(record.block_id);
    if (!selectorFailure && !structuralAuditGap && !interruptedBeforeSearch) continue;
    Object.assign(record, {
      status: "pending",
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      failure_reason: "",
      attempt_count: Math.max(0, record.attempt_count - 1),
      audit: null,
    });
    repaired += 1;
  }
  state.applied_repairs.push(repairId);
  return repaired;
}

export function repairV4DuplicateNodeSnapshotFailures(state) {
  const repairId = "v4-deduplicate-shared-node-id-v2";
  state.applied_repairs ??= [];
  if (state.applied_repairs.includes(repairId)) return 0;
  let repaired = 0;
  for (const record of state.records) {
    const duplicateSnapshotFailure = record.status === "render_failed" &&
      record.audit?.nodeCreated === true &&
      /^添加后60秒内未能唯一确认区块/.test(record.failure_reason);
    if (!duplicateSnapshotFailure) continue;
    Object.assign(record, {
      status: "pending",
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      failure_reason: "",
      attempt_count: Math.max(0, record.attempt_count - 1),
      audit: null,
    });
    repaired += 1;
  }
  state.applied_repairs.push(repairId);
  return repaired;
}

export function normalizeV4PendingWindow(state, category) {
  if (isV4AllMode(state)) {
    for (const record of state.records) {
      if (record.category === category && record.status === "standby") record.status = "pending";
    }
    return;
  }
  const records = state.records.filter((record) => record.category === category);
  const fixed = records.filter((record) => ["added", "staged"].includes(record.status)).length;
  let needed = Math.max(0, v4TargetForCategory(state, category) - fixed);
  for (const record of records.sort((left, right) => left.candidate_rank - right.candidate_rank)) {
    if (!["pending", "standby"].includes(record.status)) continue;
    record.status = needed > 0 ? "pending" : "standby";
    if (needed > 0) needed -= 1;
  }
}

export function summarizeV4State(state) {
  const counts = state.records.reduce((result, record) => {
    result[record.status] = (result[record.status] ?? 0) + 1;
    return result;
  }, {});
  return {
    counts,
    categories: Object.fromEntries(state.categories.map((category) => [category, categoryProgress(state, category)])),
    pages: state.pages.length,
    currentPage: state.current_page?.name ?? "",
  };
}

export function resetV4RecordsForRetry(state, blockIds) {
  const reset = [];
  for (const blockId of blockIds.map(String)) {
    const record = state.records.find((item) => String(item.block_id) === blockId);
    if (!record) throw new Error(`4.0状态中不存在区块 ${blockId}`);
    if (["added", "staged"].includes(record.status)) {
      throw new Error(`区块 ${blockId} 当前状态为 ${record.status}，拒绝重复添加`);
    }
    Object.assign(record, {
      status: "pending",
      page_name: "",
      page_url: "",
      slot_index: "",
      editor_dom_id: "",
      failure_reason: "",
      saved_at: "",
      audit: null,
    });
    reset.push(record);
  }
  state.last_error = "";
  return reset;
}

export function adoptV4ExistingBlock(state, { blockId, pageName, slotIndex, editorDomId, audit }) {
  const record = state.records.find((item) => String(item.block_id) === String(blockId));
  if (!record) throw new Error(`4.0状态中不存在区块 ${blockId}`);
  if (record.status === "added") return record;
  const page = state.pages.find((item) => item.name === pageName);
  if (!page) throw new Error(`4.0状态中不存在已保存页面 ${pageName}`);
  if (state.records.some((item) => item !== record && item.editor_dom_id === editorDomId)) {
    throw new Error(`画布节点 ${editorDomId} 已映射到其它区块`);
  }
  if (page.block_ids.includes(String(blockId))) throw new Error(`页面 ${pageName} 已包含区块 ${blockId}`);
  const position = Math.max(0, Math.min(Number(slotIndex) - 1, page.block_ids.length));
  for (const item of state.records) {
    if (item.page_name === pageName && item.status === "added" && Number(item.slot_index) >= Number(slotIndex)) {
      item.slot_index = Number(item.slot_index) + 1;
    }
  }
  page.block_ids.splice(position, 0, String(blockId));
  Object.assign(record, {
    status: "added",
    page_name: page.name,
    page_url: page.publicUrl,
    slot_index: Number(slotIndex),
    editor_dom_id: editorDomId,
    failure_reason: "",
    saved_at: page.saved_at,
    audit: { ...audit, evidence: "adopted_existing_unique_canvas_node" },
  });
  return record;
}

export class V4StateStore {
  constructor(stateFile) { this.stateFile = stateFile; }
  async load() {
    try { return JSON.parse(await readFile(this.stateFile, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  async save(state) {
    state.updated_at = new Date().toISOString();
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temp = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temp, this.stateFile);
  }
  async loadOrCreate(input, config) {
    const existing = await this.load();
    if (!existing) {
      const state = createInitialV4State(input, config);
      await this.save(state);
      return state;
    }
    if (existing.input_checksum !== input.checksum) throw new Error("4.0区块CSV内容已变化，拒绝复用旧状态");
    const expectedTargets = configuredV4Targets(input, config);
    if (existing.target_mode === "all" && config.v4TargetMode === "all") {
      if (existing.blocks_per_page !== config.blocksPerPage) {
        throw new Error("4.0任务的每页数量与已有状态不一致");
      }
      mergeV4AllCandidates(existing, input, config);
      return existing;
    }
    if (
      existing.blocks_per_page !== config.blocksPerPage ||
      existing.target_mode !== (config.v4TargetMode === "all" ? "all" : "fixed") ||
      JSON.stringify(existing.targets_by_category) !== JSON.stringify(expectedTargets)
    ) {
      throw new Error("4.0任务的每页数量、目标模式或分类目标与已有状态不一致");
    }
    return existing;
  }
}
