#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseCsvText, rowsToObjects } from "./csv.mjs";

function parseArgs(argv) {
  const result = { runIds: [], output: "" };
  for (let index = 2; index < argv.length; index += 1) {
    if (argv[index] === "--run-ids") result.runIds = argv[++index].split(",").map((value) => value.trim()).filter(Boolean);
    else if (argv[index] === "--output") result.output = argv[++index];
  }
  if (result.runIds.length === 0) throw new Error("必须通过 --run-ids 指定需要汇总的批次");
  return result;
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function toCsv(rows, columns) {
  return `\uFEFF${[columns.join(","), ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))].join("\r\n")}\r\n`;
}

function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

export function itemIssues(item, page) {
  const issues = [];
  const base = {
    task_id: page.id,
    page_name: page.editor_page_name,
    page_path: page.target_page_path,
    item_index: item.item_index,
    source_text: item.source_text,
  };
  const readonly = [];
  if (!item.level_editable) readonly.push("级别");
  if (!item.text_editable) readonly.push("文字");
  if (readonly.length > 0) {
    issues.push({ ...base, severity: "信息", category: "字段不可编辑", status: "field_not_editable", detail: `${readonly.join("、")}不可编辑；保留 ${item.original_level}/${item.original_text}` });
  }
  if (["edit_not_effective", "edit_failed"].includes(item.level_edit_status) ||
      ["edit_not_effective", "edit_failed"].includes(item.text_edit_status) ||
      ["save_not_available", "save_failed", "failed"].includes(item.save_status) ||
      item.sync_status === "failed") {
    issues.push({ ...base, severity: "高", category: "增长引擎修改失败", status: item.verification_status, detail: item.edit_failure_reason || item.failure_reason });
  }
  if (!["modified_verified", "partially_editable_verified", "not_editable"].includes(item.verification_status)) {
    issues.push({ ...base, severity: "高", category: "预览单项不一致", status: item.verification_status, detail: item.failure_reason });
  }
  if (!["verified", "not_applicable", "disabled"].includes(item.editor_backfill_status)) {
    issues.push({ ...base, severity: "高", category: "3.0编辑器回填不一致", status: item.editor_backfill_status, detail: item.editor_backfill_failure_reason });
  }
  return issues;
}

export async function buildSummary({ root, runIds, output }) {
  const pages = [];
  const issues = [];
  for (const runId of runIds) {
    const reportDir = path.join(root, "reports/growth-engine-h-batch", runId);
    const pageRows = rowsToObjects(parseCsvText(await readFile(path.join(reportDir, "growth-engine-h-batch-pages.csv"), "utf8")));
    const stateDir = path.join(root, ".state/growth-engine-h-batch-pages", runId);
    const stateFiles = await readdir(stateDir).catch(() => []);
    const stateById = new Map();
    for (const file of stateFiles.filter((name) => name.endsWith(".json"))) {
      stateById.set(path.basename(file, ".json"), JSON.parse(await readFile(path.join(stateDir, file), "utf8")));
    }
    for (const row of pageRows) {
      if (pages.some((page) => page.id === row.id)) throw new Error(`任务重复：${row.id}`);
      const state = stateById.get(row.id);
      const diagnostic = await readFile(
        path.join(reportDir, row.id, "read-only-diagnostic.json"),
        "utf8",
      ).then(JSON.parse).catch(() => null);
      const failureObservedCount = String(row.failure_reason ?? "").match(/增长引擎\s*(\d+)\s*项/u)?.[1];
      const page = {
        ...row,
        run_id: runId,
        item_count: state?.items?.length ?? diagnostic?.engine?.length ??
          Number(row.growth_engine_item_count || failureObservedCount || 0),
        readonly_count: state?.items?.filter((item) => !item.level_editable || !item.text_editable).length ?? 0,
        modified_verified_count: state?.items?.filter((item) => item.verification_status === "modified_verified").length ?? 0,
      };
      pages.push(page);
      const pageVerificationFailed = state?.page_verification?.status === "failed";
      const itemLevelIssues = (state?.items ?? []).flatMap((item) => itemIssues(item, page));
      // 整页数量或顺序已经不一致时，单项的预览不一致只是同一根因的表现。
      // 保留编辑、保存、回填等独立问题，但把预览问题合并成一条页面级问题。
      issues.push(...itemLevelIssues.filter((issue) =>
        !(pageVerificationFailed && issue.category === "预览单项不一致")
      ));
      if (state?.page_verification?.status === "failed") {
        const itemDifferences = (state.items ?? [])
          .filter((item) => !["modified_verified", "partially_editable_verified", "not_editable"].includes(item.verification_status))
          .map((item) => `${item.source_text || `第${item.item_index}项`}：${item.failure_reason}`)
          .filter(Boolean);
        const detail = [
          ...(state.page_verification.differences ?? []),
          ...itemDifferences,
        ].join("；");
        issues.push({ task_id: row.id, page_name: row.editor_page_name, page_path: row.target_page_path, item_index: "", source_text: "", severity: "阻断", category: "增长引擎与预览整页不一致", status: "page_verification_failed", detail });
      }
      if (row.status !== "complete" && !state?.page_verification?.differences?.length) {
        const detail = [row.failure_reason, diagnostic?.analysis].filter(Boolean).join("；");
        issues.push({ task_id: row.id, page_name: row.editor_page_name, page_path: row.target_page_path, item_index: "", source_text: "", severity: "阻断", category: "页面流程失败", status: row.status, detail });
      }
    }
  }
  const issueColumns = ["task_id", "page_name", "page_path", "item_index", "source_text", "severity", "category", "status", "detail"];
  const pageColumns = ["run_id", "id", "scope", "editor_page_name", "target_page_path", "item_count", "modified_verified_count", "readonly_count", "status", "preview_status", "editor_backfill_status", "failure_reason"];
  await mkdir(output, { recursive: true });
  const actualProblems = issues.filter((issue) => issue.severity !== "信息");
  const infoItems = issues.filter((issue) => issue.severity === "信息");
  const itemCount = pages.reduce((total, page) => total + Number(page.item_count || 0), 0);
  const verifiedCount = pages.reduce((total, page) => total + Number(page.modified_verified_count || 0), 0);
  const rows = issues.map((issue) => `<tr><td>${escapeHtml(issue.task_id)}</td><td>${escapeHtml(issue.page_name)}</td><td>${escapeHtml(issue.source_text)}</td><td>${escapeHtml(issue.severity)}</td><td>${escapeHtml(issue.category)}</td><td>${escapeHtml(issue.detail)}</td></tr>`).join("");
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>3.0增长引擎H标签测试总报告</title><style>body{font:14px/1.55 system-ui,sans-serif;margin:28px;color:#1f2937}.cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid #dbe3ee;border-radius:10px;padding:12px 16px}.card b{display:block;font-size:24px}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{padding:8px;border-bottom:1px solid #e5e7eb;text-align:left;vertical-align:top}th{background:#f8fafc}</style></head><body><h1>3.0增长引擎H标签测试总报告</h1><div class="cards"><div class="card">页面<b>${pages.length}</b></div><div class="card">通过页面<b>${pages.filter((page) => page.status === "complete").length}</b></div><div class="card">增长引擎H设置项<b>${itemCount}</b></div><div class="card">完整验证H设置项<b>${verifiedCount}</b></div><div class="card">实际问题<b>${actualProblems.length}</b></div><div class="card">不可编辑信息项<b>${infoItems.length}</b></div></div><table><thead><tr><th>任务</th><th>页面</th><th>元素</th><th>级别</th><th>类别</th><th>详情</th></tr></thead><tbody>${rows}</tbody></table></body></html>`;
  await Promise.all([
    writeFile(path.join(output, "3.0-growth-engine-page-summary.csv"), toCsv(pages, pageColumns), "utf8"),
    writeFile(path.join(output, "3.0-growth-engine-issue-list.csv"), toCsv(issues, issueColumns), "utf8"),
    writeFile(path.join(output, "3.0-growth-engine-problems-only.csv"), toCsv(actualProblems, issueColumns), "utf8"),
    writeFile(path.join(output, "3.0-growth-engine-summary.html"), html, "utf8"),
  ]);
  return { pages, issues, actualProblems, infoItems, output };
}

async function main() {
  const args = parseArgs(process.argv);
  const root = process.cwd();
  const output = args.output || path.join(root, "reports/growth-engine-h-3-summary", new Date().toISOString().replace(/\D/gu, "").slice(0, 14));
  const result = await buildSummary({ root, runIds: args.runIds, output });
  console.log(JSON.stringify({ pages: result.pages.length, actual_problems: result.actualProblems.length, readonly_items: result.infoItems.length, output: result.output }, null, 2));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
