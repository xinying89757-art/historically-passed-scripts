#!/usr/bin/env node

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { FileBlob, SpreadsheetFile, Workbook } from "@oai/artifact-tool";
import { loadGrowthEngineConfig } from "./growth-engine-h-config.mjs";
import { GrowthEngineHPage, launchGrowthEngineContext } from "./growth-engine-h-editor.mjs";
import { normalizeLevel, normalizeText, numericRunId } from "./growth-engine-h-core.mjs";

const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

function parseArgs(argv) {
  const args = {
    command: argv[2] ?? "status",
    config: "config/growth-engine-h-v3-online.json",
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
      console.log("node src/growth-engine-h-v3-online-audit.mjs <plan|run|resume|status|report> [--config FILE] [--run-id ID] [--max-pages N] [--page-path PATH]");
      process.exit(0);
    }
  }
  if (!(args.maxPages > 0)) throw new Error("--max-pages 必须大于0");
  return args;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvText(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`;
}

function spreadsheetCellValue(value) {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu, "");
}

function atomicJson(file, value) {
  return mkdir(path.dirname(file), { recursive: true }).then(async () => {
    const temp = `${file}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temp, file);
  });
}

function pagePathFromUrl(value) {
  try { return new URL(String(value)).pathname; } catch { return ""; }
}

function idMatches(text, blockId) {
  const escaped = String(blockId).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`, "u").test(String(text ?? ""));
}

function expectedHeadings(record) {
  return (record.heading_results ?? []).map((heading, index) => ({
    index: index + 1,
    text: normalizeText(heading.text),
    level: normalizeLevel(heading.level),
  }));
}

function buildInventory(source) {
  if (!Array.isArray(source.records)) throw new Error("上线区块状态缺少 records");
  const records = source.records
    .filter((record) => ["added_new", "existing_added"].includes(record.status) && record.heading_status === "configured_verified")
    .map((record) => {
      const pagePath = pagePathFromUrl(record.page_url);
      if (!pagePath) throw new Error(`区块 ${record.block_id} 页面链接无效：${record.page_url}`);
      return {
        block_id: normalizeText(record.block_id),
        block_name: normalizeText(record.app_name),
        page_name: normalizeText(record.page_name),
        page_path: pagePath,
        page_url: String(record.page_url),
        slot_index: Number(record.slot_index || 0),
        editor_dom_id: normalizeText(record.editor_dom_id),
        expected_headings: expectedHeadings(record),
        source_status: record.status,
        heading_status: record.heading_status,
      };
    });
  const pageMap = new Map();
  for (const record of records) {
    if (!pageMap.has(record.page_path)) {
      pageMap.set(record.page_path, {
        page_path: record.page_path,
        page_url: record.page_url,
        page_name: record.page_name,
        blocks: [],
      });
    }
    pageMap.get(record.page_path).blocks.push(record);
  }
  const pages = [...pageMap.values()].map((page) => ({
    ...page,
    blocks: page.blocks.sort((left, right) => left.slot_index - right.slot_index),
  }));
  return {
    source_state_file: source.source_state_file ?? "",
    records,
    pages,
    expected_h_count: records.reduce((sum, record) => sum + record.expected_headings.length, 0),
  };
}

function pathsFor(config, runId) {
  const audit = config.v3OnlineAudit;
  const reportsDir = path.join(resolveProjectPath(audit.reportsDir), runId);
  const artifactsDir = path.join(resolveProjectPath(audit.artifactsDir), runId);
  const stateFile = resolveProjectPath(audit.stateFile);
  return { reportsDir, artifactsDir, stateFile };
}

function createState(inventory, source, runId) {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "growth_engine_v3_online_editability_audit",
    run_id: runId,
    phase: "planned",
    source_state_file: inventory.source_state_file,
    site: source.site ?? null,
    target_block_count: inventory.records.length,
    target_page_count: inventory.pages.length,
    expected_h_count: inventory.expected_h_count,
    created_at: now,
    updated_at: now,
    pages: inventory.pages.map((page) => ({
      page_name: page.page_name,
      page_path: page.page_path,
      page_url: page.page_url,
      block_ids: page.blocks.map((block) => block.block_id),
      status: "pending",
      current_h_count: 0,
      failure_reason: "",
      evidence: "",
    })),
    blocks: inventory.records.map((record) => ({
      ...record,
      expected_h_count: record.expected_headings.length,
      current_h_count: 0,
      current_editable_count: 0,
      current_readonly_count: 0,
      level_readonly_count: 0,
      text_readonly_count: 0,
      attribution_scope: "",
      status: "pending",
      failure_reason: "",
      evidence: "",
      trace_path: "",
      checked_at: "",
    })),
    items: [],
    exceptions: [],
  };
}

function summarizeControls(items) {
  const mapped = items.filter((item) => item.block_id);
  if (mapped.length === 0) return {
    current_h_count: 0,
    current_editable_count: 0,
    current_readonly_count: 0,
    level_readonly_count: 0,
    text_readonly_count: 0,
    status: "mapping_unresolved",
  };
  const editable = mapped.filter((item) => item.current_status === "current_now_editable");
  const readonly = mapped.filter((item) => item.current_status !== "current_now_editable");
  return {
    current_h_count: mapped.length,
    current_editable_count: editable.length,
    current_readonly_count: readonly.length,
    level_readonly_count: mapped.filter((item) => !item.level_editable).length,
    text_readonly_count: mapped.filter((item) => !item.text_editable).length,
    status: readonly.length === 0 ? "current_now_editable" : editable.length === 0 ? "current_still_readonly" : "current_partially_readonly",
  };
}

async function nearestContextIds(control, blockIds) {
  if (!control.textInput) return [];
  return control.textInput.evaluate((input, ids) => {
    const found = [];
    const add = (value) => {
      const text = String(value ?? "");
      for (const id of ids) {
        const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        if (new RegExp(`(?:^|\\D)${escaped}(?:\\D|$)`, "u").test(text) && !found.includes(id)) found.push(id);
      }
    };
    let node = input;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      let sibling = node.previousElementSibling;
      while (sibling) { add(sibling.textContent); sibling = sibling.previousElementSibling; }
      add(node.getAttribute?.("data-block-id"));
      add(node.getAttribute?.("data-blockid"));
      node = node.parentElement;
    }
    return found;
  }, blockIds);
}

async function mapControls(controls, page) {
  const blockIds = page.blocks.map((block) => block.block_id);
  const expectedByText = new Map();
  for (const block of page.blocks) for (const heading of block.expected_headings) {
    const list = expectedByText.get(heading.text) ?? [];
    list.push(block);
    expectedByText.set(heading.text, list);
  }
  const items = [];
  for (const control of controls) {
    const idMatchesForText = page.blocks.filter((block) => idMatches(control.text, block.block_id));
    const expectedMatches = expectedByText.get(normalizeText(control.text)) ?? [];
    const contextMatches = await nearestContextIds(control, blockIds);
    const contextBlocks = page.blocks.filter((block) => contextMatches.includes(block.block_id));
    const candidates = idMatchesForText.length ? idMatchesForText : expectedMatches.length ? expectedMatches : contextBlocks;
    const unique = [...new Map(candidates.map((block) => [block.block_id, block])).values()];
    const block = unique.length === 1 ? unique[0] : null;
    const scope = idMatchesForText.length === 1
      ? "id_in_current_text"
      : expectedMatches.length === 1
        ? "expected_test_text"
        : contextBlocks.length === 1
          ? "nearest_block_context"
          : "mapping_unresolved";
    const currentStatus = control.levelEditable && control.textEditable
      ? "current_now_editable"
      : "current_readonly";
    items.push({
      block_id: block?.block_id ?? "",
      block_name: block?.block_name ?? "",
      page_name: page.page_name,
      page_path: page.page_path,
      page_url: page.page_url,
      control_index: control.index + 1,
      expected_h_count: block?.expected_headings.length ?? 0,
      current_level: control.level,
      current_text: control.text,
      level_editable: Boolean(control.levelEditable),
      text_editable: Boolean(control.textEditable),
      current_status: block ? currentStatus : "mapping_unresolved",
      attribution_scope: scope,
      attribution_confidence: block ? (scope === "id_in_current_text" ? "high" : "medium") : "none",
      checked_at: new Date().toISOString(),
    });
  }
  return items;
}

function summarize(state) {
  const statuses = {};
  for (const block of state.blocks) statuses[block.status] = (statuses[block.status] ?? 0) + 1;
  return {
    run_id: state.run_id,
    phase: state.phase,
    target_blocks: state.target_block_count,
    target_pages: state.target_page_count,
    expected_h_count: state.expected_h_count,
    checked_pages: state.pages.filter((page) => page.status === "complete").length,
    statuses,
    readonly_items: state.items.filter((item) => item.current_status === "current_readonly").length,
    unresolved_items: state.items.filter((item) => item.current_status === "mapping_unresolved").length,
    exception_count: state.exceptions.length,
  };
}

function tableHtml(rows, columns) {
  const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<table><thead><tr>${columns.map((column) => `<th>${esc(column)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((column) => `<td>${esc(row[column])}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

const blockColumns = ["block_id", "block_name", "page_name", "page_path", "page_url", "slot_index", "expected_h_count", "current_h_count", "current_editable_count", "current_readonly_count", "level_readonly_count", "text_readonly_count", "attribution_scope", "status", "failure_reason", "evidence", "trace_path", "checked_at"];
const itemColumns = ["page_path", "page_url", "block_id", "block_name", "control_index", "current_level", "current_text", "level_editable", "text_editable", "attribution_scope", "attribution_confidence", "current_status", "checked_at"];
const exceptionColumns = ["page_path", "page_url", "page_name", "exception_type", "detail", "evidence", "checked_at"];
const pageColumns = ["page_name", "page_path", "page_url", "block_ids", "status", "current_h_count", "failure_reason", "evidence"];

async function writeExcel(state, outputFile) {
  const workbook = Workbook.create();
  const readonly = state.items.filter((item) => item.current_status === "current_readonly");
  const unresolved = state.items.filter((item) => item.current_status === "mapping_unresolved");
  const sheets = [
    ["按区块结果", state.blocks, blockColumns],
    ["H设置项明细", state.items, itemColumns],
    ["仍不可编辑", readonly, itemColumns],
    ["无法归属", unresolved, itemColumns],
    ["页面异常", state.exceptions, exceptionColumns],
    ["运行状态", [summarize(state)], Object.keys(summarize(state))],
  ];
  for (const [name, rows, columns] of sheets) {
    const sheet = workbook.worksheets.add(name);
    const matrix = [columns, ...rows.map((row) => columns.map((column) => spreadsheetCellValue(row[column])))];
    const range = sheet.getRangeByIndexes(0, 0, Math.max(matrix.length, 1), columns.length);
    range.values = matrix;
    sheet.freezePanes.freezeRows(1);
    sheet.getRangeByIndexes(0, 0, 1, columns.length).format = { fill: "#1F4E78", font: { bold: true, color: "#FFFFFF" }, wrapText: true };
    range.format.wrapText = true;
    range.format.autofitColumns();
    range.format.autofitRows();
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const blob = await SpreadsheetFile.exportXlsx(workbook);
  await blob.save(outputFile);
  return outputFile;
}

async function writeReports(config, state) {
  const paths = pathsFor(config, state.run_id);
  await mkdir(paths.reportsDir, { recursive: true });
  for (const page of state.pages) {
    if (page.status === "complete") page.failure_reason = "";
  }
  if (state.trace_path) {
    for (const block of state.blocks) {
      if (block.status === "current_now_editable") {
        block.evidence = "";
        block.trace_path = "";
      } else if (!block.trace_path) {
        block.trace_path = state.trace_path;
      }
    }
  }
  state.updated_at = new Date().toISOString();
  await atomicJson(paths.stateFile, state);
  const readonly = state.items.filter((item) => item.current_status === "current_readonly");
  const unresolved = state.items.filter((item) => item.current_status === "mapping_unresolved");
  const status = summarize(state);
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>3.0上线区块增长引擎可编辑性核查</title><style>body{font:14px/1.5 system-ui;margin:24px;color:#1f2937}table{border-collapse:collapse;width:100%;margin:14px 0 30px}th,td{border:1px solid #dbe3ee;padding:6px;text-align:left;vertical-align:top;word-break:break-word}th{background:#eef4f9}</style><h1>3.0上线区块增长引擎可编辑性核查</h1><p>本批次只读取当前H设置项，未修改、未保存同步、未发布。</p><p>目标区块：${status.target_blocks}；页面：${status.target_pages}；预期H：${status.expected_h_count}；已检查页面：${status.checked_pages}</p><h2>按区块结果</h2>${tableHtml(state.blocks, blockColumns)}<h2>仍不可编辑</h2>${tableHtml(readonly, itemColumns)}<h2>无法归属</h2>${tableHtml(unresolved, itemColumns)}<h2>页面异常</h2>${tableHtml(state.exceptions, exceptionColumns)}</html>`;
  const excel = path.join(paths.reportsDir, "3.0上线区块-增长引擎核查.xlsx");
  await Promise.all([
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎按区块结果.csv"), csvText(state.blocks, blockColumns), "utf8"),
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎H设置项明细.csv"), csvText(state.items, itemColumns), "utf8"),
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎仍不可编辑.csv"), csvText(readonly, itemColumns), "utf8"),
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎无法归属.csv"), csvText(unresolved, itemColumns), "utf8"),
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎异常.csv"), csvText(state.exceptions, exceptionColumns), "utf8"),
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎运行状态.json"), `${JSON.stringify(status, null, 2)}\n`, "utf8"),
    writeFile(path.join(paths.reportsDir, "3.0上线区块-增长引擎核查-report.html"), html, "utf8"),
    writeExcel(state, excel),
  ]);
  return { reportsDir: paths.reportsDir, excel };
}

function pageConfig(baseConfig, page, artifactsDir, source) {
  const config = structuredClone(baseConfig);
  config.targetPagePath = page.page_path;
  config.pagePathCandidates = [page.page_path];
  config.publicUrl = page.page_url;
  config.growthEngineSite = {
    name: String(baseConfig.growthEngineSiteName ?? source.site?.site_name ?? baseConfig.growthEngineSite?.name ?? "").trim(),
    host: new URL(source.site.public_base_url).host,
  };
  config.paths.artifactsDir = artifactsDir;
  return config;
}

async function loadState(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function loadContext(config) {
  const sourcePath = resolveProjectPath(config.v3OnlineAudit.sourceStateFile);
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  source.source_state_file = sourcePath;
  const inventory = buildInventory(source);
  return { source, inventory };
}

async function runAudit(config, source, inventory, state, { pagePath = "", maxPages = Number.POSITIVE_INFINITY } = {}) {
  const paths = pathsFor(config, state.run_id);
  const context = await launchGrowthEngineContext(config);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  state.phase = "running";
  await atomicJson(paths.stateFile, state);
  const selected = (pagePath ? state.pages.filter((page) => page.page_path === pagePath) : state.pages)
    .filter((page) => page.status !== "complete")
    .slice(0, Number.isFinite(maxPages) ? maxPages : state.pages.length);
  try {
    for (const pageState of selected) {
      const sourcePage = inventory.pages.find((page) => page.page_path === pageState.page_path);
      if (!sourcePage) continue;
      pageState.status = "running";
      state.exceptions = state.exceptions.filter((item) => item.page_path !== sourcePage.page_path);
      const artifactPageDir = path.join(paths.artifactsDir, sourcePage.page_path.replaceAll("/", "_"));
      const cfg = pageConfig(config, sourcePage, artifactPageDir, source);
      let editor;
      try {
        editor = new GrowthEngineHPage(context, cfg);
        await editor.open();
        const refresh = await editor.refreshAndWait({ failureStatus: "refresh_failed" });
        pageState.refresh_started_at = refresh.startedAt;
        pageState.refreshed_at = refresh.completedAt;
        const dialog = await editor.openEditDialog({ allowEmpty: true });
        try {
          const controls = await editor.inspectDialog(dialog, { allowEmpty: true });
          const items = await mapControls(controls, sourcePage);
          state.items = state.items.filter((item) => item.page_path !== sourcePage.page_path);
          state.items.push(...items);
          pageState.current_h_count = controls.length;
          pageState.status = "complete";
          pageState.failure_reason = "";
          for (const block of sourcePage.blocks) {
            const target = state.blocks.find((item) => item.block_id === block.block_id && item.page_path === block.page_path);
            const mapped = items.filter((item) => item.block_id === block.block_id);
            const summary = summarizeControls(mapped);
            const expected = block.expected_headings.length;
            const hasMismatch = mapped.length > 0 && mapped.length !== expected;
            Object.assign(target, summary, {
              expected_h_count: expected,
              attribution_scope: [...new Set(mapped.map((item) => item.attribution_scope))].join(","),
              status: mapped.length === 0 ? (controls.length === 0 ? "no_h_detected" : "mapping_unresolved") : hasMismatch ? "mapping_unresolved" : summary.status,
              failure_reason: hasMismatch ? `预期${expected}项，当前唯一归属${mapped.length}项` : "",
              checked_at: new Date().toISOString(),
            });
          }
          const unresolvedItems = items.filter((item) => item.current_status === "mapping_unresolved");
          for (const item of unresolvedItems) state.exceptions.push({
            page_path: sourcePage.page_path,
            page_url: sourcePage.page_url,
            page_name: sourcePage.page_name,
            exception_type: "mapping_unresolved",
            detail: `第${item.control_index}项无法唯一归属：${item.current_level}/${item.current_text}`,
            evidence: "",
            checked_at: new Date().toISOString(),
          });
          const needsEvidence = items.some((item) => ["current_readonly", "mapping_unresolved"].includes(item.current_status));
          if (needsEvidence) {
            const evidence = await editor.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-audit.png`);
            pageState.evidence = evidence;
            for (const block of state.blocks.filter((item) => item.page_path === sourcePage.page_path)) {
              if (["current_partially_readonly", "current_still_readonly", "mapping_unresolved"].includes(block.status)) block.evidence = evidence;
            }
            for (const exception of state.exceptions.filter((item) => item.page_path === sourcePage.page_path && !item.evidence)) exception.evidence = evidence;
          }
        } finally {
          await editor.cancelDialog(dialog).catch(() => {});
        }
      } catch (error) {
        const message = String(error?.message ?? error);
        const status = /page_not_found/u.test(message) ? "page_not_found" : /login_expired|重新登录/u.test(message) ? "login_expired" : /refresh_failed/u.test(message) ? "refresh_failed" : "automation_error";
        pageState.status = status;
        pageState.failure_reason = message;
        const evidence = await editor?.screenshot(`page-${sourcePage.page_path.replaceAll("/", "_")}-${status}.png`).catch(() => "") ?? "";
        pageState.evidence = evidence;
        for (const block of state.blocks.filter((item) => item.page_path === sourcePage.page_path)) Object.assign(block, { status, failure_reason: message, evidence, checked_at: new Date().toISOString() });
        state.exceptions.push({ page_path: sourcePage.page_path, page_url: sourcePage.page_url, page_name: sourcePage.page_name, exception_type: status, detail: message, evidence, checked_at: new Date().toISOString() });
        if (status === "login_expired") { state.phase = status; await atomicJson(paths.stateFile, state); break; }
      }
      state.updated_at = new Date().toISOString();
      await atomicJson(paths.stateFile, state);
    }
    if (state.phase !== "login_expired") state.phase = state.pages.every((page) => page.status === "complete") ? "complete" : "completed_with_failures";
  } finally {
    const tracePath = path.join(paths.artifactsDir, "growth-engine-h-v3-online-audit-trace.zip");
    await mkdir(path.dirname(tracePath), { recursive: true });
    await context.tracing.stop({ path: tracePath }).catch(() => {});
    await context.close().catch(() => {});
    state.trace_path = tracePath;
    state.updated_at = new Date().toISOString();
    await atomicJson(paths.stateFile, state);
  }
  const report = await writeReports(config, state);
  console.log(JSON.stringify({ ...summarize(state), report }, null, 2));
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  const config = await loadGrowthEngineConfig(args.config);
  const { source, inventory } = await loadContext(config);
  if (args.command === "plan") {
    console.log(JSON.stringify({ source_state_file: inventory.source_state_file, site: source.site, target_blocks: inventory.records.length, target_pages: inventory.pages.length, expected_h_count: inventory.expected_h_count, pages: inventory.pages.map((page) => ({ page_name: page.page_name, page_path: page.page_path, block_count: page.blocks.length, block_ids: page.blocks.map((block) => block.block_id) })) }, null, 2));
    return;
  }
  const stateFile = resolveProjectPath(config.v3OnlineAudit.stateFile);
  if (args.command === "status") {
    const state = await loadState(stateFile);
    console.log(state ? JSON.stringify(summarize(state), null, 2) : "尚未创建审计状态，请先运行 plan 后再运行 run");
    return;
  }
  if (args.command === "report") {
    const state = await loadState(stateFile);
    if (!state) throw new Error("没有找到审计状态");
    console.log(JSON.stringify(await writeReports(config, state), null, 2));
    return;
  }
  const runId = args.runId || numericRunId();
  const paths = pathsFor(config, runId);
  let state;
  if (args.command === "resume") {
    state = await loadState(stateFile);
    if (!state) throw new Error("没有可恢复的审计状态");
  } else if (args.command === "run") {
    const existing = await loadState(stateFile);
    if (existing && !["complete", "completed_with_failures", "login_expired"].includes(existing.phase)) throw new Error("已有未完成审计状态，请使用 resume");
    state = createState(inventory, source, runId);
  } else {
    throw new Error(`未知命令：${args.command}`);
  }
  await runAudit(config, source, inventory, state, args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  main().catch((error) => { console.error(error.stack || error.message || error); process.exitCode = 1; });
}
