import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.mjs";
import { StateStore } from "./state.mjs";

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function resolveSourceStateFiles(config) {
  return (config.v3FullSourceStateFiles ?? []).map((filePath) =>
    path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath),
  );
}

function placementFrom(record, sourceName) {
  return {
    page_name: record.page_name ?? "",
    page_url: record.page_url ?? "",
    slot_index: record.slot_index ?? "",
    editor_dom_id: record.editor_dom_id ?? "",
    h1_count: record.h1_count ?? 0,
    h2_count: record.h2_count ?? 0,
    h3_count: record.h3_count ?? 0,
    h4_count: record.h4_count ?? 0,
    h5_count: record.h5_count ?? 0,
    h6_count: record.h6_count ?? 0,
    image_count: record.image_count ?? 0,
    image_urls: record.image_urls ?? [],
    status: "existing_added",
    placement_origin: sourceName,
    source_status: record.status,
    saved_at: record.saved_at ?? "",
    audit: record.audit ?? null,
  };
}

export async function createV3FullInitialState(input, config) {
  const [original, ranking] = await Promise.all(
    resolveSourceStateFiles(config).map(readJsonIfExists),
  );
  const originalAdded = new Map(
    (original?.records ?? []).filter((record) => record.status === "added").map((record) => [String(record.block_id), record]),
  );
  const rankingAdded = new Map(
    (ranking?.records ?? []).filter((record) => record.status === "added").map((record) => [String(record.block_id), record]),
  );

  const records = input.records.map((sourceRecord) => {
    const originalRecord = originalAdded.get(sourceRecord.block_id);
    const rankingRecord = rankingAdded.get(sourceRecord.block_id);
    const placement = rankingRecord
      ? placementFrom(rankingRecord, "ranking-heading-run-state")
      : originalRecord
        ? placementFrom(originalRecord, "run-state")
        : {
            page_name: "", page_url: "", slot_index: "", editor_dom_id: "",
            h1_count: 0, h2_count: 0, h3_count: 0, h4_count: 0, h5_count: 0, h6_count: 0,
            image_count: 0, image_urls: [], status: "pending", placement_origin: "",
            source_status: "", saved_at: "", audit: null,
          };
    const existingHeading = rankingRecord?.heading_status === "configured";
    return {
      ...sourceRecord,
      ...placement,
      failure_reason: "",
      attempt_count: 0,
      published: false,
      heading_status: existingHeading ? "existing_configured_unverified" : "pending",
      heading_results: existingHeading ? structuredClone(rankingRecord.heading_results ?? rankingRecord.heading_poc ?? []) : [],
      heading_poc: existingHeading ? structuredClone(rankingRecord.heading_poc ?? rankingRecord.heading_results ?? []) : [],
      heading_failure_reason: "",
      heading_verified_at: rankingRecord?.heading_verified_at ?? "",
    };
  });

  const pagesByName = new Map();
  for (const record of records.filter((item) => item.status === "existing_added")) {
    const pageState = pagesByName.get(record.page_name) ?? {
      name: record.page_name,
      publicUrl: record.page_url,
      block_ids: [],
      imported: true,
    };
    pageState.block_ids.push(record.block_id);
    pagesByName.set(record.page_name, pageState);
  }
  for (const pageState of pagesByName.values()) {
    pageState.block_ids.sort((leftId, rightId) => {
      const left = records.find((record) => record.block_id === leftId);
      const right = records.find((record) => record.block_id === rightId);
      return Number(left?.slot_index ?? 0) - Number(right?.slot_index ?? 0);
    });
  }

  const now = new Date().toISOString();
  return {
    version: 1,
    created_at: now,
    updated_at: now,
    input_checksum: input.checksum,
    input_dir: input.inputDir,
    source_rows: input.sourceRows,
    unique_count: input.uniqueCount,
    target_count: input.records.length,
    excluded_count: input.excluded.length,
    blocks_per_page: config.blocksPerPage,
    next_page_number: 1,
    current_page: null,
    pages: [...pagesByName.values()],
    excluded: input.excluded,
    records,
  };
}

export async function loadOrCreateV3FullState(input, config) {
  const store = new StateStore(config.paths.v3FullStateFile);
  let state = await store.load();
  if (!state) {
    state = await createV3FullInitialState(input, config);
    await store.save(state);
  } else {
    if (state.input_checksum !== input.checksum) {
      throw new Error("全量JSON内容已变化，拒绝复用旧状态文件；请先备份并创建新状态");
    }
    if (state.blocks_per_page !== config.blocksPerPage) {
      throw new Error("blocksPerPage与全量状态不一致，拒绝恢复");
    }
    let migrated = false;
    for (const record of state.records) {
      if (
        ["not_found", "locator_ambiguous", "add_failed", "render_failed", "save_failed"].includes(record.status) &&
        record.heading_status === "pending"
      ) {
        record.heading_status = "not_applicable_not_added";
        record.heading_failure_reason = "区块未成功添加，本阶段无法设置H2";
        migrated = true;
      }
      if (
        record.heading_status === "unsupported_no_h_control" &&
        /(locator\.|Timeout|Error:|Element is not|元素不是)/u.test(record.heading_failure_reason ?? "")
      ) {
        record.heading_status = "heading_failed";
        migrated = true;
      }
    }
    if (migrated) await store.save(state);
  }
  return { state, store };
}

export function summarizeV3FullState(state) {
  const count = (predicate) => state.records.filter(predicate).length;
  return {
    sourceRows: state.source_rows,
    unique: state.unique_count,
    target: state.target_count,
    excluded: state.excluded_count,
    existing: count((record) => record.status === "existing_added"),
    addedNew: count((record) => record.status === "added_new"),
    missing: count((record) => record.status === "pending"),
    existingConfigured: count((record) => record.heading_status === "existing_configured_unverified"),
    configuredVerified: count((record) => record.heading_status === "configured_verified"),
    headingRemaining: count((record) =>
      ["existing_added", "added_new"].includes(record.status) &&
      ["pending", "existing_configured_unverified", "configured_pending_page_save"].includes(record.heading_status),
    ),
    headingNotApplicable: count((record) => record.heading_status === "not_applicable_not_added"),
    importedPages: state.pages.filter((page) => page.imported).length,
    newPages: state.pages.filter((page) => !page.imported).length,
    maxNewPages: Math.ceil(count((record) => record.status === "pending") / state.blocks_per_page),
  };
}
