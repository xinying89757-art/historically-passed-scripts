#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeText, numericRunId, stripSyncSuffix } from "./growth-engine-h-core.mjs";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? "status",
    config: "config/growth-engine-h-v3-readonly-recheck.json",
    runId: "",
    maxPages: Number.POSITIVE_INFINITY,
    pagePath: "",
  };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--config") args.config = argv[++index];
    else if (argv[index] === "--run-id") args.runId = String(argv[++index]);
    else if (argv[index] === "--max-pages") args.maxPages = Number(argv[++index]);
    else if (argv[index] === "--page-path") args.pagePath = String(argv[++index]);
    else if (argv[index] === "--help") {
      console.log("node src/growth-engine-h-v3-readonly-recheck.mjs <plan|auth|run|resume|status|report> [--config FILE] [--max-pages N] [--page-path PATH] [--run-id ID]");
      process.exit(0);
    }
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

function resolveSourcePath(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function splitExpectedTexts(value) {
  return String(value ?? "").split(/[；;]+/u).map((text) => normalizeText(text)).filter(Boolean);
}

function pagePathFromUrl(value) {
  try {
    return new URL(String(value)).pathname;
  } catch {
    return "";
  }
}

async function readEvidenceItems(file, blockId, expectedTexts) {
  try {
    const state = JSON.parse(await readFile(file, "utf8"));
    const expectedSet = new Set(expectedTexts.map((text) => normalizeText(text)));
    return (state.items ?? [])
      .filter((item) => String(item.editor_setting_id ?? "") === String(blockId) ||
        expectedSet.has(normalizeText(item.original_text)) ||
        expectedSet.has(normalizeText(item.source_text)))
      .map((item) => ({
        historical_index: item.item_index,
        expected_text: normalizeText(item.original_text || item.source_text || ""),
        candidate_texts: [...new Set([
          item.original_text,
          item.source_text,
          stripSyncSuffix(item.expected_text),
          stripSyncSuffix(item.requested_text),
          item.editor_actual_text,
        ].map((text) => normalizeText(text)).filter(Boolean))],
        historical_level: normalizeText(item.original_level),
        historical_level_editable: item.level_editable,
        historical_text_editable: item.text_editable,
      }));
  } catch {
    return [];
  }
}

export async function readReadonlyWorkbook(workbookPath) {
  const bytes = await readFile(workbookPath);
  const workbook = await SpreadsheetFile.importXlsx(bytes);
  const sheet = workbook.worksheets.getItem("只读问题明细");
  if (!sheet || sheet.isNullObject) throw new Error("历史问题工作簿缺少“只读问题明细”工作表");
  const values = sheet.getRange("A5:K24").values;
  const records = [];
  for (let index = 0; index < values.length; index += 1) {
    const row = values[index];
    if (!normalizeText(row[0])) continue;
    const expectedTexts = splitExpectedTexts(row[6]);
    if (!row[3] || !pagePathFromUrl(row[3])) throw new Error(`历史问题第 ${index + 5} 行页面链接无效`);
    if (expectedTexts.length === 0) throw new Error(`历史问题第 ${index + 5} 行缺少原始测试文字`);
    const evidenceItems = await readEvidenceItems(normalizeText(row[10]), normalizeText(row[0]), expectedTexts);
    const historicalItems = evidenceItems.length > 0
      ? evidenceItems
      : expectedTexts.map((text, itemIndex) => ({
        historical_index: itemIndex + 1,
        expected_text: text,
        candidate_texts: [text],
        historical_level: "",
        historical_level_editable: "",
        historical_text_editable: "",
      }));
    records.push({
      source_row: index + 5,
      block_id: normalizeText(row[0]),
      block_name: normalizeText(row[1]),
      editor_page_name: normalizeText(row[2]),
      page_url: normalizeText(row[3]),
      page_path: pagePathFromUrl(row[3]),
      historical_readonly_count: Number(row[4] || expectedTexts.length),
      historical_readonly_fields: normalizeText(row[5]),
      expected_texts: expectedTexts,
      historical_items: historicalItems,
      evidence_path: normalizeText(row[10]),
    });
  }
  if (records.length !== 20) throw new Error(`历史问题工作簿预期20个区块，实际${records.length}个`);
  if (new Set(records.map((row) => row.block_id)).size !== records.length) {
    throw new Error("历史问题工作簿存在重复区块ID，拒绝继续以免错配");
  }
  const pageMap = new Map();
  for (const record of records) {
    if (!pageMap.has(record.page_path)) {
      pageMap.set(record.page_path, {
        page_path: record.page_path,
        page_url: record.page_url,
        editor_page_name: record.editor_page_name,
        blocks: [],
      });
    }
    pageMap.get(record.page_path).blocks.push(record);
  }
  return { workbookPath, records, pages: [...pageMap.values()] };
}

function pageConfig(baseConfig, page, runId) {
  const config = structuredClone(baseConfig);
  config.targetPagePath = page.page_path;
  config.pagePathCandidates = [page.page_path];
  config.publicUrl = page.page_url;
  config.paths.artifactsDir = path.join(baseConfig.v3ReadonlyRecheck.artifactsDir, runId, page.page_path.replaceAll("/", "_"));
  return config;
}

function atomicJson(file, value) {
  return mkdir(path.dirname(file), { recursive: true }).then(async () => {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, file);
  });
}

function createState(inventory, runId) {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "growth_engine_v3_readonly_recheck",
    run_id: runId,
    phase: "planned",
    source_workbook: inventory.workbookPath,
    target_block_count: inventory.records.length,
    target_page_count: inventory.pages.length,
    created_at: now,
    updated_at: now,
    pages: inventory.pages.map((page) => ({
      page_path: page.page_path,
      page_url: page.page_url,
      editor_page_name: page.editor_page_name,
      status: "pending",
      block_ids: page.blocks.map((block) => block.block_id),
    })),
    blocks: inventory.records.map((block) => ({
      ...block,
      status: "pending",
      current_check_item_count: 0,
      matched_item_count: 0,
      current_editable_count: 0,
      current_readonly_count: 0,
      level_readonly_count: 0,
      text_readonly_count: 0,
      failure_reason: "",
      evidence: block.evidence_path,
    })),
    items: [],
    exceptions: [],
  };
}

function saveState(file, state) {
  state.updated_at = new Date().toISOString();
  return atomicJson(file, state);
}

function controlSnapshot(control) {
  return {
    control_index: control.index + 1,
    current_level: control.level,
    current_text: control.text,
    level_editable: Boolean(control.levelEditable),
    text_editable: Boolean(control.textEditable),
  };
}

function makeItemRow(block, expectedText, expectedIndex, result = {}) {
  return {
    run_id: result.run_id ?? "",
    page_path: block.page_path,
    page_url: block.page_url,
    editor_page_name: block.editor_page_name,
    block_id: block.block_id,
    block_name: block.block_name,
    expected_index: expectedIndex,
    expected_text: expectedText,
    historical_readonly_fields: block.historical_readonly_fields,
    current_level: result.current_level ?? "",
    current_text: result.current_text ?? "",
    level_editable: result.level_editable ?? "",
    text_editable: result.text_editable ?? "",
    mapping_status: result.mapping_status ?? "not_checked",
    current_status: result.current_status ?? "",
    failure_reason: result.failure_reason ?? "",
    checked_at: result.checked_at ?? new Date().toISOString(),
  };
}

export function mapControlsToTargets(page, controls, runId) {
  const expected = page.blocks.flatMap((block) => (block.historical_items ?? block.expected_texts.map((text, index) => ({
    historical_index: index + 1,
    expected_text: text,
    candidate_texts: [text],
  }))).map((historical, index) => ({
    block,
    historical,
    text: historical.expected_text,
    expected_index: index + 1,
  })));
  const matchText = (value) => stripSyncSuffix(normalizeText(value));
  const byText = new Map();
  for (const target of expected) {
    const key = matchText(target.historical.candidate_texts[0] || target.text);
    if (!byText.has(key)) byText.set(key, []);
    byText.get(key).push(target);
  }
  const rows = [];
  const usedControls = new Set();
  for (const [text, targets] of byText) {
    const candidates = controls.filter((control) => targets.some((target) =>
      target.historical.candidate_texts.some((candidate) => matchText(candidate) === matchText(control.text))));
    if (candidates.length !== targets.length) {
      const status = candidates.length > targets.length ? "mapping_ambiguous" : "test_data_missing";
      const reason = candidates.length > targets.length
        ? `当前文字“${text}”匹配到${candidates.length}个设置项，历史目标为${targets.length}个，禁止随机归属`
        : `刷新后的设置列表未找到历史测试文字“${text}”`;
      for (const target of targets) {
        rows.push(makeItemRow(target.block, target.text, target.expected_index, {
          run_id: runId,
          mapping_status: status,
          current_status: status,
          failure_reason: reason,
        }));
      }
      continue;
    }
    for (let index = 0; index < targets.length; index += 1) {
      const target = targets[index];
      const control = candidates[index];
      usedControls.add(control.index);
      const snapshot = controlSnapshot(control);
      const currentStatus = snapshot.level_editable && snapshot.text_editable
        ? "now_editable"
        : (snapshot.level_editable || snapshot.text_editable ? "partially_readonly" : "still_readonly");
      rows.push(makeItemRow(target.block, target.text, target.expected_index, {
        run_id: runId,
        ...snapshot,
        mapping_status: "mapped",
        current_status: currentStatus,
      }));
    }
  }
  return {
    items: rows,
    unmatched: controls.filter((control) => !usedControls.has(control.index)).map(controlSnapshot),
  };
}

export function aggregateBlock(block, items, pageError = "") {
  const rows = items.filter((item) => item.block_id === block.block_id && item.page_path === block.page_path);
  const currentReadonly = rows.filter((item) => item.mapping_status === "mapped" && item.current_status !== "now_editable");
  const mapped = rows.filter((item) => item.mapping_status === "mapped");
  const missing = rows.filter((item) => item.mapping_status === "test_data_missing");
  const ambiguous = rows.filter((item) => item.mapping_status === "mapping_ambiguous");
  const levelReadonly = rows.filter((item) => item.mapping_status === "mapped" && item.level_editable === false).length;
  const textReadonly = rows.filter((item) => item.mapping_status === "mapped" && item.text_editable === false).length;
  let status = "now_editable";
  let reason = "";
  if (pageError) {
    status = pageError;
    reason = pageError;
  } else if (ambiguous.length > 0 && currentReadonly.length === 0) {
    status = "mapping_ambiguous";
    reason = rows.find((item) => item.mapping_status === "mapping_ambiguous")?.failure_reason ?? "映射不唯一";
  } else if (mapped.length === 0) {
    status = "test_data_missing";
    reason = "刷新后的H设置列表中没有可归属的历史测试数据";
  } else if (currentReadonly.length > 0) {
    status = currentReadonly.length === mapped.length && missing.length === 0 ? "still_readonly" : "partially_readonly";
    reason = `当前${currentReadonly.length}个已匹配设置项存在只读字段`;
    if (missing.length > 0) reason += `；另有${missing.length}个历史设置项未找到`;
  } else if (missing.length > 0 || ambiguous.length > 0) {
    status = missing.length > 0 ? "test_data_missing" : "mapping_ambiguous";
    reason = rows.find((item) => item.mapping_status === status)?.failure_reason ?? "历史设置项未能完整匹配";
  }
  return {
    ...block,
    status,
    current_check_item_count: rows.length,
    matched_item_count: mapped.length,
    current_editable_count: mapped.filter((item) => item.current_status === "now_editable").length,
    current_readonly_count: currentReadonly.length,
    level_readonly_count: levelReadonly,
    text_readonly_count: textReadonly,
    failure_reason: reason,
    checked_at: new Date().toISOString(),
  };
}

function summarizeState(state) {
  const statuses = Object.fromEntries([...new Set(state.blocks.map((block) => block.status))].map((status) => [status, state.blocks.filter((block) => block.status === status).length]));
  return {
    run_id: state.run_id,
    phase: state.phase,
    target_pages: state.target_page_count,
    target_blocks: state.target_block_count,
    checked_pages: state.pages.filter((page) => page.status !== "pending").length,
    statuses,
    item_count: state.items.length,
    exception_count: state.exceptions.length,
  };
}

const blockColumns = [
  "run_id", "block_id", "block_name", "editor_page_name", "page_path", "page_url",
  "historical_readonly_count", "historical_readonly_fields", "current_check_item_count",
  "matched_item_count", "current_editable_count", "current_readonly_count",
  "level_readonly_count", "text_readonly_count", "status", "failure_reason", "evidence", "checked_at",
];
const itemColumns = [
  "run_id", "page_path", "page_url", "editor_page_name", "block_id", "block_name",
  "expected_index", "expected_text", "historical_readonly_fields", "current_level", "current_text",
  "level_editable", "text_editable", "mapping_status", "current_status", "failure_reason", "checked_at",
];
const exceptionColumns = ["run_id", "page_path", "page_url", "editor_page_name", "exception_type", "detail", "evidence", "checked_at"];

function htmlTable(rows, columns) {
  const header = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const body = rows.map((row) => `<tr>${columns.map((column) => `<td>${escapeHtml(row[column])}</td>`).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function spreadsheetCellValue(value) {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") return JSON.stringify(value, null, 0);
  return value;
}

async function writeExcel(state, outputDir) {
  const workbook = Workbook.create();
  const blockRows = state.blocks.map((row) => ({ ...row, run_id: state.run_id }));
  const sheets = [
    ["回归结果", blockRows, blockColumns],
    ["仍不可编辑", blockRows.filter((row) => ["still_readonly", "partially_readonly"].includes(row.status)), blockColumns],
    ["已恢复可编辑", blockRows.filter((row) => row.status === "now_editable"), blockColumns],
    ["异常待确认", blockRows.filter((row) => !["still_readonly", "partially_readonly", "now_editable"].includes(row.status)), blockColumns],
    ["H设置项明细", state.items, itemColumns],
    ["运行状态", [summarizeState(state)], Object.keys(summarizeState(state))],
  ];
  for (const [name, rows, columns] of sheets) {
    const sheet = workbook.worksheets.add(name);
    const matrix = [columns, ...rows.map((row) => columns.map((column) => spreadsheetCellValue(row[column])))];
    const range = sheet.getRangeByIndexes(0, 0, Math.max(matrix.length, 1), columns.length);
    range.values = matrix.length ? matrix : [columns];
    sheet.freezePanes.freezeRows(1);
    const header = sheet.getRangeByIndexes(0, 0, 1, columns.length);
    header.format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, wrapText: true };
    range.format.wrapText = true;
    range.format.autofitColumns();
    range.format.autofitRows();
  }
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `3.0增长引擎只读问题回归-${state.run_id}.xlsx`);
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await blob.save(file);
  return file;
}

export async function writeReports(config, state) {
  const reportsDir = path.join(config.v3ReadonlyRecheck.reportsDir, state.run_id);
  await mkdir(reportsDir, { recursive: true });
  // The block objects originate from the source workbook, so attach the run id
  // at report time (the item-level rows already carry it). This keeps every CSV
  // and workbook row traceable to the exact regression batch.
  const blockRows = state.blocks.map((row) => ({ ...row, run_id: state.run_id }));
  const readonly = blockRows.filter((row) => ["still_readonly", "partially_readonly"].includes(row.status));
  const editable = blockRows.filter((row) => row.status === "now_editable");
  const exceptions = state.exceptions;
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>3.0增长引擎只读问题回归</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#1f2937}table{border-collapse:collapse;width:100%;margin:12px 0 28px}th,td{border:1px solid #d9e1ea;padding:6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eef4f9}h1{margin-bottom:4px}.bad{color:#b42318;font-weight:700}.good{color:#067647;font-weight:700}</style></head><body><h1>3.0增长引擎20个只读问题回归</h1><p>批次：${escapeHtml(state.run_id)}；阶段：${escapeHtml(state.phase)}；目标页面：${state.target_page_count}；目标区块：${state.target_block_count}</p><h2>仍不可编辑 / 部分只读（${readonly.length}）</h2>${htmlTable(readonly, blockColumns)}<h2>已恢复可编辑（${editable.length}）</h2>${htmlTable(editable, blockColumns)}<h2>异常待确认（${exceptions.length}）</h2>${htmlTable(exceptions, exceptionColumns)}</body></html>`;
  await Promise.all([
    writeFile(path.join(reportsDir, "3.0只读问题回归-区块结果.csv"), csvText(blockRows, blockColumns), "utf8"),
    writeFile(path.join(reportsDir, "3.0只读问题回归-H设置项明细.csv"), csvText(state.items, itemColumns), "utf8"),
    writeFile(path.join(reportsDir, "3.0只读问题回归-仍不可编辑.csv"), csvText(readonly, blockColumns), "utf8"),
    writeFile(path.join(reportsDir, "3.0只读问题回归-已恢复可编辑.csv"), csvText(editable, blockColumns), "utf8"),
    writeFile(path.join(reportsDir, "3.0只读问题回归-异常.csv"), csvText(exceptions, exceptionColumns), "utf8"),
    writeFile(path.join(reportsDir, "3.0只读问题回归-运行状态.json"), `${JSON.stringify(summarizeState(state), null, 2)}\n`, "utf8"),
    writeFile(path.join(reportsDir, "3.0只读问题回归-report.html"), html, "utf8"),
  ]);
  const excel = await writeExcel(state, config.v3ReadonlyRecheck.outputDir);
  return { reportsDir, excel };
}

async function auth(config) {
  const context = await launchGrowthEngineContext(config, { auth: true });
  const page = context.pages()[0] ?? await context.newPage();
  await page.goto(config.loginUrl, { waitUntil: "domcontentloaded", timeout: config.timeouts.navigationMs });
  console.log("已打开增长引擎登录页，请完成登录后关闭浏览器窗口。");
  await new Promise((resolve) => context.on("close", resolve));
}

async function run(config, inventory, state, { resume = false, maxPages = Number.POSITIVE_INFINITY, pagePath = "" } = {}) {
  const context = await launchGrowthEngineContext(config);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  state.phase = "running";
  await saveState(config.v3ReadonlyRecheck.stateFile, state);
  const candidatePages = pagePath ? state.pages.filter((page) => page.page_path === pagePath) : state.pages;
  if (pagePath && candidatePages.length !== 1) throw new Error(`页面路径 ${pagePath} 在回归状态中匹配数量为 ${candidatePages.length}`);
  const selectedPages = candidatePages.slice(0, Number.isFinite(maxPages) ? maxPages : candidatePages.length);
  try {
    for (const pageState of selectedPages) {
      if (pageState.status === "complete" && !pagePath) continue;
      const sourcePage = inventory.pages.find((page) => page.page_path === pageState.page_path);
      const pageCfg = pageConfig(config, sourcePage, state.run_id);
      state.exceptions = state.exceptions.filter((exception) => exception.page_path !== sourcePage.page_path);
      pageState.status = "running";
      await saveState(config.v3ReadonlyRecheck.stateFile, state);
      let editor;
      try {
        editor = new GrowthEngineHPage(context, pageCfg);
        await editor.open();
        await editor.refreshAndWait({ failureStatus: "refresh_failed" });
        const dialog = await editor.openEditDialog({ allowEmpty: true });
        try {
          const controls = await editor.inspectDialog(dialog, { allowEmpty: true });
          const mapped = mapControlsToTargets(sourcePage, controls, state.run_id);
          state.items = state.items.filter((item) => item.page_path !== sourcePage.page_path);
          state.items.push(...mapped.items);
          for (const block of sourcePage.blocks) {
            const result = aggregateBlock(block, mapped.items);
            const index = state.blocks.findIndex((item) => item.page_path === block.page_path && item.block_id === block.block_id);
            if (index >= 0) state.blocks[index] = result;
          }
          const readonlyBlocks = state.blocks.filter((block) => block.page_path === sourcePage.page_path &&
            ["still_readonly", "partially_readonly"].includes(block.status));
          if (readonlyBlocks.length > 0) {
            const screenshot = await editor.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-readonly.png`);
            for (const block of readonlyBlocks) block.evidence = screenshot;
          }
          for (const unmatched of mapped.unmatched) {
            state.exceptions.push({
              run_id: state.run_id,
              page_path: sourcePage.page_path,
              page_url: sourcePage.page_url,
              editor_page_name: sourcePage.editor_page_name,
              exception_type: "unmapped_engine_item",
              detail: `增长引擎存在未能安全归属到20个历史区块的设置项：${unmatched.current_level}/${unmatched.current_text}`,
              evidence: "",
              checked_at: new Date().toISOString(),
            });
          }
          pageState.status = "complete";
          pageState.current_check_item_count = controls.length;
          pageState.unmatched_engine_item_count = mapped.unmatched.length;
          pageState.refreshed_at = new Date().toISOString();
        } finally {
          await editor.cancelDialog(dialog).catch(() => {});
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        const status = /page_not_found/u.test(message) ? "page_not_found"
          : /login_expired|重新登录/u.test(message) ? "login_expired"
            : /refresh_failed/u.test(message) ? "refresh_failed" : "automation_error";
        pageState.status = status;
        pageState.failure_reason = message;
        for (const block of sourcePage.blocks) {
          const index = state.blocks.findIndex((item) => item.page_path === block.page_path && item.block_id === block.block_id);
          if (index >= 0) state.blocks[index] = aggregateBlock(block, [], status);
        }
        state.exceptions.push({
          run_id: state.run_id,
          page_path: sourcePage.page_path,
          page_url: sourcePage.page_url,
          editor_page_name: sourcePage.editor_page_name,
          exception_type: status,
          detail: message,
          evidence: "",
          checked_at: new Date().toISOString(),
        });
        await mkdir(pageCfg.paths.artifactsDir, { recursive: true });
        const shot = await editor?.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-${status}.png`).catch(() => "");
        if (shot) state.exceptions.at(-1).evidence = shot;
        if (status === "login_expired") {
          state.phase = "login_expired";
          await saveState(config.v3ReadonlyRecheck.stateFile, state);
          break;
        }
      }
      await saveState(config.v3ReadonlyRecheck.stateFile, state);
    }
    if (state.phase !== "login_expired") {
      state.phase = state.pages.every((page) => page.status === "complete") ? "complete" : "completed_with_failures";
    }
  } finally {
    const tracePath = path.join(config.v3ReadonlyRecheck.artifactsDir, state.run_id, "growth-engine-h-v3-readonly-recheck-trace.zip");
    await mkdir(path.dirname(tracePath), { recursive: true });
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
    state.trace_path = tracePath;
    await saveState(config.v3ReadonlyRecheck.stateFile, state);
  }
  const report = await writeReports(config, state);
  console.log(JSON.stringify({ ...summarizeState(state), report }, null, 2));
}

async function loadState(config) {
  try {
    return JSON.parse(await readFile(config.v3ReadonlyRecheck.stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const config = await loadGrowthEngineConfig(args.config);
  if (args.command === "auth") return auth(config);
  const inventory = await readReadonlyWorkbook(config.v3ReadonlyRecheck.sourceWorkbook);
  if (args.command === "plan") {
    console.log(JSON.stringify({ workbook: inventory.workbookPath, blocks: inventory.records.length, pages: inventory.pages.length, page_paths: inventory.pages.map((page) => page.page_path) }, null, 2));
    return;
  }
  if (args.command === "status") {
    const state = await loadState(config);
    console.log(state ? JSON.stringify(summarizeState(state), null, 2) : "尚无3.0只读回归运行状态");
    return;
  }
  if (args.command === "report") {
    const state = await loadState(config);
    if (!state) throw new Error("尚无3.0只读回归运行状态");
    console.log(JSON.stringify(await writeReports(config, state), null, 2));
    return;
  }
  if (!["run", "resume"].includes(args.command)) throw new Error(`未知命令：${args.command}`);
  const existing = await loadState(config);
  const state = args.command === "resume"
    ? existing
    : createState(inventory, args.runId || numericRunId());
  if (!state) throw new Error("没有可恢复的3.0只读回归状态");
  await run(config, inventory, state, { resume: args.command === "resume", maxPages: args.maxPages, pagePath: args.pagePath });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
