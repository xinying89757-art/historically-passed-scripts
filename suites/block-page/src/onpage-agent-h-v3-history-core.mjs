import { stripAgentSuffix } from "./onpage-agent-h-core.mjs";

export const PREFLIGHT_TARGET_IDS = [
  "expand-blocks-021",
  "expand-blocks-033",
  "expand-blocks-042",
  "expand-blocks-066",
  "expand-blocks-109",
  "expand-blocks-110",
  "expand-blocks-122",
];

export function parseHistorySubject(item) {
  const value = String(item.original_text ?? item.source_text ?? "");
  const component = value.match(/^组件(标题|内容)测试-(\d+)-([^｜]+)/u);
  if (component) {
    return {
      objectType: "组件",
      objectId: component[2],
      objectName: component[3].replace(/-+$/u, "").trim(),
    };
  }
  const block = value.match(/^区块标题测试-(\d+)-(.+?)(?:-第\d+项)?(?:｜|$)/u);
  if (block) {
    return {
      objectType: "区块",
      objectId: block[1],
      objectName: block[2].replace(/-第\d+项$/u, "").trim(),
    };
  }
  return null;
}

export function itemMatchesSource(item, source) {
  if (source.itemKey && String(item.item_key ?? item.itemKey ?? "") !== String(source.itemKey)) return false;
  if (source.settingId && String(item.setting_id ?? item.settingId ?? "") !== String(source.settingId)) return false;
  if (source.position !== undefined && String(item.position ?? item.index ?? "") !== String(source.position)) return false;
  if (source.itemKey) return true;
  return stripAgentSuffix(item.original_text ?? item.source_text ?? item.origin?.text ?? "")
    === stripAgentSuffix(source.sourceText ?? source.text ?? "");
}

export function regressionStatus(item, issueGroup) {
  if (["modified_verified", "partially_editable_verified"].includes(item.status)) return "fixed_verified";
  if (issueGroup === "origin_mismatch") {
    if (item.status === "origin_mismatch") return "still_origin_mismatch";
    if (item.status === "update_failed") return "validate_recovered_update_failed";
  }
  if (item.status === "validate_failed") return "still_validate_failed";
  return item.status || "automation_error";
}

export function summarizeBatchValidation({ batchPassed, individualPassed, individualFailed }) {
  if (batchPassed) return "batch_validate_passed";
  if (individualFailed === 0 && individualPassed > 0) return "batch_validate_failed_individual_passed";
  if (individualPassed > 0) return "batch_validate_failed_individual_partial";
  return "batch_validate_failed_individual_failed";
}

export function buildObjectRows(state, targets) {
  const rows = [];
  for (const target of targets) {
    const page = state.pages.find((entry) => entry.target_id === target.id);
    const groups = new Map();
    for (const source of target.allowedSources ?? []) {
      const objectType = source.objectType ?? (target.scope === "components" ? "组件" : "区块");
      const objectId = String(source.objectId ?? "");
      const key = `${objectType}|${objectId}`;
      if (!groups.has(key)) groups.set(key, { objectType, objectId, objectName: source.objectName ?? "", sources: [] });
      groups.get(key).sources.push(source);
    }
    for (const group of groups.values()) {
      const items = group.sources.map((source) => (page?.items ?? []).find((item) => itemMatchesSource(item, source))).filter(Boolean);
      const statuses = items.map((item) => item.regression_status ?? regressionStatus(item, target.issueGroup));
      let status = "fixed_verified";
      if (items.length !== group.sources.length) status = "historical_target_missing";
      else if (statuses.some((value) => value === "still_origin_mismatch")) status = "still_origin_mismatch";
      else if (statuses.some((value) => value === "still_validate_failed")) status = "still_validate_failed";
      else if (statuses.some((value) => value === "validate_recovered_update_failed")) status = "validate_recovered_update_failed";
      else if (statuses.some((value) => value !== "fixed_verified")) status = statuses.find((value) => value !== "fixed_verified") || "automation_error";
      rows.push({
        issue_group: target.issueGroup,
        object_type: group.objectType,
        object_id: group.objectId,
        object_name: group.objectName,
        page_name: target.pageName,
        page_path: target.pagePath,
        page_url: target.pageUrl,
        historical_h_count: group.sources.length,
        matched_h_count: items.length,
        fixed_h_count: statuses.filter((value) => value === "fixed_verified").length,
        failed_h_count: statuses.filter((value) => value !== "fixed_verified").length + (group.sources.length - items.length),
        regression_status: status,
        problem_description: status === "fixed_verified"
          ? "历史失败项已恢复，预检、更新、预览和编辑器回填均验证通过。"
          : items.map((item) => item.failure_reason).filter(Boolean).join("；") || `历史目标H应有${group.sources.length}处，当前仅匹配${items.length}处。`,
        evidence: [...new Set(items.flatMap((item) => [item.validate_response_evidence, item.update_response_evidence, item.screenshot]).filter(Boolean))].join("\n"),
      });
    }
  }
  return rows;
}

