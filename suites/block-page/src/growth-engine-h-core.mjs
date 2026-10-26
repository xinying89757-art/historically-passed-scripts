const HEADING_LEVELS = ["H1", "H2", "H3", "H4", "H5", "H6"];

export function normalizeText(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

export function normalizeLevel(value) {
  const level = String(value ?? "").trim().toUpperCase();
  if (!HEADING_LEVELS.includes(level)) {
    throw new Error(`无效的 H 标签级别：${value}`);
  }
  return level;
}

export function nextHeadingLevel(value) {
  const level = normalizeLevel(value);
  return HEADING_LEVELS[(HEADING_LEVELS.indexOf(level) + 1) % HEADING_LEVELS.length];
}

export function resolveHeadingGroupCount(levelControlCount, textControlCount) {
  if (!Number.isInteger(levelControlCount) || !Number.isInteger(textControlCount)) {
    throw new Error("H 标签设置项数量必须是整数");
  }
  if (levelControlCount < 1 || textControlCount < 1 || levelControlCount !== textControlCount) {
    throw new Error(
      `locator_ambiguous: 级别控件 ${levelControlCount} 个，文字控件 ${textControlCount} 个`,
    );
  }
  return textControlCount;
}

export function numericRunId(date = new Date()) {
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ];
  return parts.map((part) => String(part).padStart(2, "0")).join("");
}

const SYNC_SUFFIX_PATTERN = /｜(?:同步验证批次\d+第\d+项|新接口验证批次\d+第\d+项|接口复跑新页面\d+)$/u;

export function stripSyncSuffix(value) {
  let result = normalizeText(value);
  while (SYNC_SUFFIX_PATTERN.test(result)) result = result.replace(SYNC_SUFFIX_PATTERN, "").trim();
  return result;
}

export function resolveSourceText({ currentText, previousItem }) {
  const current = normalizeText(currentText);
  const previousExpected = normalizeText(previousItem?.expected_text);
  if (previousItem && current && current === previousExpected) {
    return stripSyncSuffix(previousItem.source_text || previousItem.original_text || current);
  }
  return stripSyncSuffix(current);
}

export function makeExpectedText({ sourceText, pagePath, itemIndex, runId }) {
  const pageNumber = String(pagePath).match(/(\d+)/u)?.[1] ?? "000";
  const source = stripSyncSuffix(sourceText) || `页面${pageNumber.padStart(3, "0")}第${String(itemIndex).padStart(2, "0")}项`;
  return `${source}｜同步验证批次${runId}第${String(itemIndex).padStart(2, "0")}项`;
}

export function classifyItemVerification(item, liveHeadings) {
  if (!item.level_editable && !item.text_editable) {
    return {
      status: "not_editable",
      live_level: item.original_level,
      live_text: item.original_text,
      failure_reason: "",
    };
  }

  const expectedText = normalizeText(item.expected_text);
  const matches = liveHeadings.filter(
    (heading) => normalizeText(heading.text) === expectedText,
  );
  if (matches.length === 0) {
    return {
      status: "live_missing",
      live_level: "",
      live_text: "",
      failure_reason: `真实网页未找到预期文字：${expectedText}`,
    };
  }
  if (matches.length > 1) {
    return {
      status: "live_text_mismatch",
      live_level: matches.map((heading) => heading.level).join("|"),
      live_text: expectedText,
      failure_reason: `真实网页中预期文字出现 ${matches.length} 次，应恰好出现 1 次`,
    };
  }
  const [match] = matches;
  if (normalizeLevel(match.level) !== normalizeLevel(item.expected_level)) {
    return {
      status: "live_level_mismatch",
      live_level: normalizeLevel(match.level),
      live_text: normalizeText(match.text),
      failure_reason: `真实级别 ${match.level} 与预期 ${item.expected_level} 不一致`,
    };
  }
  return {
    status:
      item.level_editable && item.text_editable
        ? "modified_verified"
        : "partially_editable_verified",
    live_level: normalizeLevel(match.level),
    live_text: normalizeText(match.text),
    failure_reason: "",
  };
}

export function compareHeadingLists(expected, actual) {
  const differences = [];
  if (expected.length !== actual.length) {
    differences.push(`数量不一致：增长引擎 ${expected.length}，真实网页 ${actual.length}`);
  }
  const length = Math.max(expected.length, actual.length);
  for (let index = 0; index < length; index += 1) {
    const left = expected[index];
    const right = actual[index];
    if (!left || !right) {
      continue;
    }
    if (
      normalizeLevel(left.level) !== normalizeLevel(right.level) ||
      normalizeText(left.text) !== normalizeText(right.text)
    ) {
      differences.push(
        `第 ${index + 1} 项不一致：增长引擎 ${left.level}/${normalizeText(left.text)}；真实网页 ${right.level}/${normalizeText(right.text)}`,
      );
    }
  }
  return { matches: differences.length === 0, differences };
}

/**
 * Compare the headings reported by the growth engine with the public DOM.
 * Some 3.0 blocks render carousel/product clones in the public page, so the
 * DOM can contain additional headings that are not editable settings. Those
 * extras must not block a write, while every engine item must still be
 * present with the same level/text and multiplicity.
 */
export function compareHeadingSubset(expected, actual) {
  const key = (heading) => `${normalizeLevel(heading.level)}\u0000${normalizeText(heading.text)}`;
  const expectedCounts = new Map();
  const actualCounts = new Map();
  for (const heading of expected) expectedCounts.set(key(heading), (expectedCounts.get(key(heading)) ?? 0) + 1);
  for (const heading of actual) actualCounts.set(key(heading), (actualCounts.get(key(heading)) ?? 0) + 1);
  const differences = [];
  for (const [headingKey, count] of expectedCounts) {
    const actualCount = actualCounts.get(headingKey) ?? 0;
    if (actualCount < count) {
      const [level, text] = headingKey.split("\u0000");
      differences.push(`网页缺少 ${count - actualCount} 项：${level}/${text}`);
    }
  }
  return { matches: differences.length === 0, differences };
}

export function isTerminalStatus(status) {
  return new Set([
    "modified_verified",
    "partially_editable_verified",
    "not_editable",
    "edit_failed",
    "sync_failed",
    "live_missing",
    "live_level_mismatch",
    "live_text_mismatch",
    "locator_ambiguous",
    "login_expired",
  ]).has(status);
}

export { HEADING_LEVELS };
