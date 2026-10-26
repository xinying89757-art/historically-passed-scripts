import { nextHeadingLevel, normalizeLevel, normalizeText } from "./growth-engine-h-core.mjs";
import { stripAgentSuffix } from "./onpage-agent-h-core.mjs";

const LIVE_SUFFIX = /｜新接口真实页验证批次\d+第\d+项$/u;

export function stripLiveSuffix(value) {
  let result = stripAgentSuffix(value);
  while (LIVE_SUFFIX.test(result)) result = result.replace(LIVE_SUFFIX, "").trim();
  return result;
}

export function makeLiveText({ sourceText, runId, itemIndex }) {
  const source = stripLiveSuffix(sourceText) || `空标题第${String(itemIndex).padStart(2, "0")}项`;
  return `${source}｜新接口真实页验证批次${runId}第${String(itemIndex).padStart(2, "0")}项`;
}

function identifierMatch(item, heading) {
  const ids = new Set((heading.containerIds ?? []).map(String));
  return [item.settingId, item.nodeId, item.templateId]
    .filter(Boolean)
    .some((value) => ids.has(String(value)));
}

export function mapCapturedItemsToLive(capturedItems, headings) {
  const used = new Set();
  return capturedItems.map((captured, capturedIndex) => {
    const candidatesFor = (predicate) => headings
      .map((heading, headingIndex) => ({ heading, headingIndex }))
      .filter(({ heading, headingIndex }) => !used.has(headingIndex) && predicate(heading));
    let candidates = candidatesFor((heading) => identifierMatch(captured, heading));
    let source = "live_container_id";
    if (candidates.length !== 1) {
      candidates = candidatesFor((heading) =>
        normalizeText(heading.text) === normalizeText(captured.origin?.text)
        && normalizeLevel(heading.level) === normalizeLevel(captured.origin?.tagName));
      source = "live_text_level";
    }
    if (candidates.length !== 1) {
      candidates = candidatesFor((heading) => normalizeText(heading.text) === normalizeText(captured.origin?.text));
      source = "live_unique_text";
    }
    if (candidates.length !== 1 && headings.length === capturedItems.length && !used.has(capturedIndex)) {
      candidates = [{ heading: headings[capturedIndex], headingIndex: capturedIndex }];
      source = "live_same_order";
    }
    if (candidates.length !== 1) {
      return { captured: structuredClone(captured), mappingStatus: "mapping_ambiguous", mappingSource: "", heading: null, headingIndex: -1 };
    }
    const [{ heading, headingIndex }] = candidates;
    used.add(headingIndex);
    return {
      captured: {
        ...structuredClone(captured),
        origin: { tagName: normalizeLevel(heading.level).toLowerCase(), text: normalizeText(heading.text) },
      },
      mappingStatus: "mapped",
      mappingSource: source,
      heading: structuredClone(heading),
      headingIndex,
    };
  });
}

export function buildEditableTarget(item, capability, runId, itemIndex) {
  const levelEditable = Boolean(capability?.editable && capability?.fieldCapabilities?.type === true);
  const textEditable = Boolean(capability?.editable && capability?.fieldCapabilities?.text === true);
  const originalLevel = normalizeLevel(item.origin?.tagName);
  const originalText = normalizeText(item.origin?.text);
  const target = {};
  if (levelEditable) target.tagName = nextHeadingLevel(originalLevel).toLowerCase();
  if (textEditable) target.text = makeLiveText({ sourceText: originalText, runId, itemIndex });
  return {
    target,
    levelEditable,
    textEditable,
    expectedLevel: levelEditable ? normalizeLevel(target.tagName) : originalLevel,
    expectedText: textEditable ? target.text : originalText,
  };
}

export function verifyLiveItem(item, headings) {
  const matches = headings.filter((heading) => normalizeText(heading.text) === normalizeText(item.expected_text));
  if (matches.length === 0) return { status: "live_missing", reason: `真实页面未找到预期文字“${item.expected_text}”`, actualLevel: "", actualText: "", count: 0 };
  if (matches.length > 1) return { status: "live_duplicate", reason: `真实页面预期文字出现${matches.length}次`, actualLevel: matches.map((entry) => normalizeLevel(entry.level)).join("|"), actualText: item.expected_text, count: matches.length };
  const match = matches[0];
  if (normalizeLevel(match.level) !== normalizeLevel(item.expected_level)) {
    return { status: "live_level_mismatch", reason: `真实页面级别${normalizeLevel(match.level)}与预期${normalizeLevel(item.expected_level)}不一致`, actualLevel: normalizeLevel(match.level), actualText: normalizeText(match.text), count: 1 };
  }
  return { status: "verified", reason: "", actualLevel: normalizeLevel(match.level), actualText: normalizeText(match.text), count: 1 };
}

export function verifyUntouchedHeadings(baselineHeadings, submittedHeadingIndexes, currentHeadings) {
  const counts = new Map();
  for (const heading of currentHeadings) {
    const key = `${normalizeLevel(heading.level)}\u0000${normalizeText(heading.text)}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const missing = [];
  baselineHeadings.forEach((heading, index) => {
    if (submittedHeadingIndexes.has(index)) return;
    const key = `${normalizeLevel(heading.level)}\u0000${normalizeText(heading.text)}`;
    const count = counts.get(key) ?? 0;
    if (count < 1) missing.push({ headingIndex: index, level: normalizeLevel(heading.level), text: normalizeText(heading.text) });
    else counts.set(key, count - 1);
  });
  return { status: missing.length === 0 ? "verified" : "live_text_mismatch", missing };
}

