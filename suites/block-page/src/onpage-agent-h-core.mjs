import { nextHeadingLevel, normalizeLevel, normalizeText } from "./growth-engine-h-core.mjs";

const AGENT_SUFFIX = /｜(?:同步验证批次\d+第\d+项|接口同步测试批次\d+第\d+项|新接口验证批次\d+第\d+项|接口复跑新页面\d+)$/u;

export function stripAgentSuffix(value) {
  let result = normalizeText(value);
  while (AGENT_SUFFIX.test(result)) result = result.replace(AGENT_SUFFIX, "").trim();
  return result;
}

export function makeAgentText({ sourceText, runId, itemIndex }) {
  const source = stripAgentSuffix(sourceText) || `空标题第${String(itemIndex).padStart(2, "0")}项`;
  return `${source}｜新接口验证批次${runId}第${String(itemIndex).padStart(2, "0")}项`;
}

export function buildScenarioTarget(item, scenario, runId, itemIndex) {
  const originalLevel = normalizeLevel(item.origin?.tagName);
  const originalText = normalizeText(item.origin?.text);
  const generatedText = makeAgentText({ sourceText: originalText, runId, itemIndex });
  if (scenario === "text_only") {
    return { target: { text: generatedText }, expectedLevel: originalLevel, expectedText: generatedText };
  }
  if (scenario === "level_only") {
    const level = nextHeadingLevel(originalLevel);
    return { target: { tagName: level.toLowerCase() }, expectedLevel: level, expectedText: originalText };
  }
  if (scenario === "empty_text") {
    // Keep the original level in the request so this case isolates whether an
    // empty heading text is accepted, instead of also testing an omitted tag.
    return { target: { tagName: originalLevel.toLowerCase(), text: "" }, expectedLevel: originalLevel, expectedText: "" };
  }
  if (scenario === "both") {
    const level = nextHeadingLevel(originalLevel);
    return {
      target: { tagName: level.toLowerCase(), text: generatedText },
      expectedLevel: level,
      expectedText: generatedText,
    };
  }
  throw new Error(`不支持的新接口H测试场景：${scenario}`);
}

export function validateCapturedHeadingPayload(payload) {
  if (!payload || !Array.isArray(payload.items) || payload.items.length === 0) {
    throw new Error("mapping_ambiguous: 未捕获到增长引擎标题定位请求");
  }
  return payload.items.map((item, index) => {
    if (!item.itemKey || !item.origin?.tagName || !("text" in item.origin)) {
      throw new Error(`mapping_ambiguous: 捕获请求第 ${index + 1} 项缺少 itemKey 或 origin`);
    }
    return structuredClone(item);
  });
}

function headingMatchesContainer(heading, item) {
  const identifiers = new Set((heading.containerIds ?? []).map(String));
  return [item.settingId, item.nodeId, item.templateId]
    .filter(Boolean)
    .some((identifier) => identifiers.has(String(identifier)));
}

export function reconcileCurrentOrigins(capturedItems, previewHeadings) {
  const used = new Set();
  return capturedItems.map((item, itemIndex) => {
    let candidates = previewHeadings
      .map((heading, index) => ({ heading, index }))
      .filter(({ index }) => !used.has(index) && headingMatchesContainer(previewHeadings[index], item));
    let source = "preview_container";
    if (candidates.length !== 1) {
      candidates = previewHeadings
        .map((heading, index) => ({ heading, index }))
        .filter(({ heading, index }) => !used.has(index) && normalizeText(heading.text) === normalizeText(item.origin?.text));
      source = "preview_unique_text";
    }
    if (candidates.length !== 1 && previewHeadings.length === capturedItems.length && !used.has(itemIndex)) {
      candidates = [{ heading: previewHeadings[itemIndex], index: itemIndex }];
      source = "preview_same_order";
    }
    if (candidates.length !== 1) {
      throw new Error(`mapping_ambiguous: ${item.itemKey} 无法与当前预览H唯一对应`);
    }
    const [{ heading, index }] = candidates;
    used.add(index);
    return {
      ...structuredClone(item),
      origin: { tagName: normalizeLevel(heading.level).toLowerCase(), text: normalizeText(heading.text) },
    };
  });
}

export function classifyApiItem({ validateItem, updateItem, scenario }) {
  const requiresLevel = ["level_only", "both"].includes(scenario);
  const requiresText = ["text_only", "empty_text", "both"].includes(scenario);
  if (validateItem?._validateFailed) {
    return { status: "validate_failed", reason: validateItem.reason || "新接口预检失败" };
  }
  if (!validateItem?.editable) {
    if (/ORIGIN|MATCH|原值/u.test(validateItem?.reason ?? "")) {
      return { status: "origin_mismatch", reason: validateItem.reason };
    }
    return { status: "field_not_editable", reason: validateItem?.reason || "预检返回不可编辑" };
  }
  if (requiresLevel && validateItem.fieldCapabilities?.type !== true) {
    return { status: "field_not_editable", reason: validateItem?.reason || "级别字段不可编辑" };
  }
  if (requiresText && validateItem.fieldCapabilities?.text !== true) {
    return { status: "field_not_editable", reason: validateItem?.reason || "文字字段不可编辑" };
  }
  if (!updateItem) return { status: "response_mismatch", reason: "更新响应缺少对应 itemKey" };
  if (updateItem.status !== "UPDATED") {
    const reason = updateItem.reason || "更新响应未返回 UPDATED";
    if (/ORIGIN|MATCH|原值/u.test(reason)) return { status: "origin_mismatch", reason };
    if (/POSITION|INDEX|位置/u.test(reason)) return { status: "position_required", reason };
    return { status: "update_failed", reason };
  }
  return { status: "updated", reason: "" };
}

function headingContainerMatches(heading, item) {
  const identifiers = heading.containerIds ?? [];
  return [item.settingId, item.nodeId, item.templateId]
    .filter(Boolean)
    .some((identifier) => identifiers.includes(String(identifier)));
}

export function verifyPreviewItem(item, headings) {
  let matches;
  if (item.expected_text === "") {
    matches = headings.filter((heading) => heading.text === "" && headingContainerMatches(heading, item));
  } else {
    matches = headings.filter((heading) => normalizeText(heading.text) === normalizeText(item.expected_text));
    const contextual = matches.filter((heading) => headingContainerMatches(heading, item));
    if (contextual.length > 0) matches = contextual;
  }
  if (matches.length === 0) {
    return { status: "preview_text_mismatch", reason: `预览页未找到预期文字“${item.expected_text}”`, actualLevel: "", actualText: "" };
  }
  if (matches.length > 1) {
    return { status: "preview_text_mismatch", reason: `预览页预期文字出现 ${matches.length} 次，无法唯一定位`, actualLevel: matches.map((entry) => entry.level).join("|"), actualText: item.expected_text };
  }
  const [match] = matches;
  if (normalizeLevel(match.level) !== normalizeLevel(item.expected_level)) {
    return { status: "preview_level_mismatch", reason: `预览级别 ${match.level} 与预期 ${item.expected_level} 不一致`, actualLevel: match.level, actualText: match.text };
  }
  return { status: "verified", reason: "", actualLevel: match.level, actualText: match.text };
}

export function verifyUnsubmittedHeadings(capturedItems, submittedKeys, headings) {
  const counts = new Map();
  for (const heading of headings) {
    const key = `${normalizeLevel(heading.level)}\u0000${normalizeText(heading.text)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = [];
  for (const item of capturedItems) {
    if (submittedKeys.has(item.itemKey)) continue;
    const key = `${normalizeLevel(item.origin.tagName)}\u0000${normalizeText(item.origin.text)}`;
    const count = counts.get(key) ?? 0;
    if (count < 1) missing.push(`${item.itemKey}:${item.origin.tagName}/${normalizeText(item.origin.text)}`);
    else counts.set(key, count - 1);
  }
  return { status: missing.length === 0 ? "verified" : "preview_mismatch", missing };
}

export function summarizePage(items, unsubmittedStatus) {
  const failures = items.filter((item) => ![
    "modified_verified", "partially_editable_verified", "field_not_editable",
  ].includes(item.status));
  return failures.length === 0 && unsubmittedStatus === "verified" ? "complete" : "failed";
}
