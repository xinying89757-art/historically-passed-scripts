import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const runId = "20260824130303";
const batchFile = path.join(root, ".state/growth-engine-h-v3-full-batch-state.json");
const pagesDir = path.join(root, ".state/growth-engine-h-v3-full-pages", runId);
const rankingFile = path.join(root, ".state/growth-engine-v3-full-ranking-source.json");

const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));
const normalize = (v) => String(v ?? "").replace(/\s+/gu, " ").trim();
const stripSync = (v) => normalize(v).replace(/｜同步验证批次\d+第\d+项$/u, "");
const isReadonly = (item) => item.level_editable === false || item.text_editable === false;
const isTestText = (v) => /^区块标题测试-\d+/u.test(stripSync(v));
const idFromText = (v) => {
  const m = stripSync(v).match(/(?:区块标题测试|页面\d+)[-—](\d+)/u);
  return m?.[1] ?? "";
};
const parseSourceName = (v) => {
  const m = String(v ?? "").match(/^(\d+)-(.*)$/u);
  return m ? { id: m[1], name: m[2] } : { id: "", name: String(v ?? "") };
};

const batch = await readJson(batchFile);
const ranking = await readJson(rankingFile);
const nameMap = new Map();
for (const record of ranking.records ?? []) {
  if (record.block_id && record.app_name) nameMap.set(String(record.block_id), record.app_name);
}
for (const task of batch.tasks ?? []) {
  for (const raw of task.source_names ?? []) {
    const parsed = parseSourceName(raw);
    if (parsed.id && parsed.name && !nameMap.has(parsed.id)) nameMap.set(parsed.id, parsed.name);
  }
}

const pageFiles = await (await import("node:fs/promises")).readdir(pagesDir);
const pageStates = new Map();
for (const file of pageFiles.filter((f) => f.endsWith(".json"))) {
  const state = await readJson(path.join(pagesDir, file));
  pageStates.set(state.page_path, { ...state, stateFile: path.join(pagesDir, file) });
}

const productReasons = new Map();
const reviewReasons = new Map();
const readonlyRows = [];
const addReason = (map, key, reason) => {
  if (!map.has(key)) map.set(key, []);
  if (!map.get(key).includes(reason)) map.get(key).push(reason);
};

const issueForItem = (page, item) => {
  const reasons = [];
  if (page.refreshed_engine_headings?.length === 0 && (page.baseline_live_headings?.length ?? 0) > 0) {
    reasons.push({ type: "growth_engine_h_not_detected", severity: "P1", description: `基线公开页面检测到 ${page.baseline_live_headings.length} 个 H 标签，但刷新后增长引擎扫描结果为 0；编辑标签弹窗显示“当前页面未检测到 H 标签”。` });
  }
  if (item.verification_status === "live_missing") {
    reasons.push({ type: "preview_h_missing", severity: "P1", description: `预览页未找到预期 H 文本“${item.expected_text}”。` });
  } else if (item.verification_status === "live_text_mismatch") {
    reasons.push({ type: "preview_h_mismatch", severity: "P1", description: `预览页 H 文本或级别与预期不一致；预期 ${item.expected_level}/${item.expected_text}，实际 ${item.live_level || "空"}/${item.live_text || "空"}。` });
  }
  if (item.editor_backfill_status === "mismatch") {
    reasons.push({ type: "editor_backfill_mismatch", severity: "P1", description: item.editor_backfill_failure_reason || "3.0 编辑器设置项回填的文字或级别与增长引擎预期不一致。" });
  } else if (item.editor_backfill_status === "not_found") {
    reasons.push({ type: "editor_backfill_not_found", severity: "P1", description: item.editor_backfill_failure_reason || "在编辑器中未找到对应测试文字或设置项。" });
  } else if (item.editor_backfill_status === "locator_ambiguous") {
    reasons.push({ type: "editor_backfill_locator_ambiguous", severity: "待复核", description: item.editor_backfill_failure_reason || "编辑器回填定位不唯一。" });
  } else if (item.editor_backfill_status === "check_failed" || item.editor_backfill_status === "pending") {
    reasons.push({ type: "editor_backfill_automation_exception", severity: "待复核", description: item.editor_backfill_failure_reason || "编辑器回填核查未完成。" });
  }
  if (item.save_status === "failed") reasons.push({ type: "save_failed", severity: "P1", description: item.failure_reason || "保存操作失败。" });
  if (item.sync_status === "failed") reasons.push({ type: "sync_failed", severity: "P1", description: item.failure_reason || "同步操作失败。" });
  if (item.verification_status === "pending") reasons.push({ type: "verification_pending", severity: "待复核", description: item.failure_reason || "预览核查未完成。" });
  return reasons;
};

const issueRows = [];
const reviewRows = [];
for (const task of batch.tasks ?? []) {
  const page = pageStates.get(task.target_page_path);
  const pageLink = page?.public_url || page?.preview_url || `http://site.example.invalid${task.target_page_path || ""}`;
  if (!page) {
    reviewRows.push({ 页面: task.editor_page_name, 页面路径: task.target_page_path, 页面链接: pageLink, 区块ID: "", 区块名称: "", 问题类型: task.status === "page_not_found" ? "page_not_found" : "page_state_missing", 问题描述: task.failure_reason || "未找到该页面的运行状态文件，需人工复核。", 证据文件: task.page_reports_dir || "" });
    continue;
  }
  for (const item of page.items ?? []) {
    const readonly = isReadonly(item);
    const blockId = String(item.editor_setting_id || idFromText(item.expected_text) || idFromText(item.original_text) || "");
    if (readonly) {
      readonlyRows.push({ 区块ID: blockId, 区块名称: nameMap.get(blockId) || "", 编辑器页面: task.editor_page_name, 页面链接: pageLink, 原始文字: item.original_text || item.source_text || "", 只读字段: [item.level_editable === false ? "级别" : "", item.text_editable === false ? "文字" : ""].filter(Boolean).join("、"), 增长引擎状态: item.verification_status, 备注: "增长引擎中只读，按本次口径排除，不计入问题" });
      continue;
    }
    const reasons = issueForItem(page, item);
    if (!reasons.length) continue;
    const configured = isTestText(item.original_text) || isTestText(item.source_text) || isTestText(item.expected_text);
    for (const reason of reasons) {
      const row = { task, page, pageLink, item, blockId, configured, reason };
      if (reason.severity === "P1" && configured) {
        const key = `${blockId || "page"}:${task.target_page_path}`;
        addReason(productReasons, key, row);
      } else {
        reviewRows.push({ 页面: task.editor_page_name, 页面路径: task.target_page_path, 页面链接: pageLink, 区块ID: blockId, 区块名称: nameMap.get(blockId) || "", 问题类型: reason.type, 问题描述: `${reason.description}${configured ? "" : "（未确认存在本轮测试数据，暂不直接定性为产品 Bug）"}`, 证据文件: [page.stateFile, item.editor_backfill_screenshot, task.page_reports_dir].filter(Boolean).join("；") });
      }
    }
  }
}

for (const rows of productReasons.values()) {
  const first = rows[0];
  const { task, page, pageLink, blockId } = first;
  issueRows.push({ 区块ID: blockId || "页面级", 区块名称: nameMap.get(blockId) || "（按页面证据归属）", 编辑器页面: task.editor_page_name, 页面链接: pageLink, 问题类型: [...new Set(rows.map((r) => r.reason.type))].join("、"), 问题描述: [...new Set(rows.map((r) => r.reason.description))].join("；"), Bug严重程度: "P1", 复核状态: "已从非只读项复核证据确认", 增长引擎设置项数: rows.length, 证据文件: [page.stateFile, task.page_reports_dir, ...rows.map((r) => r.item.editor_backfill_screenshot)].filter(Boolean).join("；") });
}

reviewRows.push({
  页面: "批次复核入口",
  页面路径: "",
  页面链接: "https://admin.example.invalid/phoenix2/composite/middle/platform/index.html",
  区块ID: "",
  区块名称: "",
  问题类型: "recheck_network_error",
  问题描述: "本次继续复核时，增长引擎入口返回 ERR_EMPTY_RESPONSE；属于网络/环境异常，不直接定性为产品 Bug。",
  证据文件: "/tmp/ge-recheck-next/block-002.log",
});
reviewRows.push({
  页面: "全部预览页面",
  页面路径: "93个已保存页面",
  页面链接: "http://site.example.invalid/",
  区块ID: "",
  区块名称: "",
  问题类型: "preview_domain_unavailable",
  问题描述: "二次请求时预览域名均返回 404/不可达；公开域名回退可访问但不是预览环境，不能用回退结果判定同步是否成功。",
  证据文件: "reports/growth-engine-h-v3-full-batch/20260824130303/preview-recheck.json",
});

const pageRows = (batch.tasks ?? []).map((task) => {
  const page = pageStates.get(task.target_page_path);
  return { 任务ID: task.id, 编辑器页面: task.editor_page_name, 页面路径: task.target_page_path, 页面链接: page?.public_url || page?.preview_url || `http://site.example.invalid${task.target_page_path || ""}`, 任务状态: task.status, 页面阶段: page?.phase || "page_not_found", 基线H数量: page?.baseline_live_headings?.length ?? "", 刷新后增长引擎H数量: page?.refreshed_engine_headings?.length ?? "", 最终预览H数量: page?.final_live_headings?.length ?? "", 预览核验: page?.page_verification?.status || "未执行", 编辑器回填核验: page?.editor_backfill_verification?.status || "未执行", 证据文件: page?.stateFile || task.page_reports_dir || "" };
});

const counts = { totalTasks: batch.tasks?.length ?? 0, processedPages: pageStates.size, completeTasks: (batch.tasks ?? []).filter((t) => t.status === "complete").length, failedTasks: (batch.tasks ?? []).filter((t) => t.status === "failed").length, pageNotFoundTasks: (batch.tasks ?? []).filter((t) => t.status === "page_not_found").length, issueBlocks: issueRows.length, readonlyItemsExcluded: readonlyRows.length, reviewRows: reviewRows.length };
const output = { runId, generatedAt: new Date().toISOString(), counts, issueRows, reviewRows, readonlyRows, pageRows, evidence: { batchFile, pagesDir, rankingFile, reportsDir: path.join(root, "reports/growth-engine-h-v3-full-batch", runId) } };
const out = process.argv[2] || path.join(root, "reports/growth-engine-h-v3-full-batch", runId, "final-issues-data.json");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ out, counts }, null, 2));
