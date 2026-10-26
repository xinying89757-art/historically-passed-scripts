import { nextHeadingLevel, normalizeLevel, normalizeText } from "./growth-engine-h-core.mjs";

const DETAIL_SUFFIX = /｜新接口详情验证批次\d+第\d+项$/u;

export function detailTypeForPageType(pageType) {
  if (pageType === "产品") return "PRODUCT";
  if (pageType === "文章") return "ARTICLE";
  if (pageType === "产品分类描述") return "PRODUCT_GROUP";
  if (pageType === "视频详情") return "VIDEO";
  throw new Error(`unsupported_detail_type: 不支持的页面类型 ${pageType}`);
}

export function stripDetailSuffix(value) {
  let result = normalizeText(value);
  while (DETAIL_SUFFIX.test(result)) result = result.replace(DETAIL_SUFFIX, "").trim();
  return result;
}

export function makeDetailText({ sourceText, runId, itemIndex }) {
  const base = stripDetailSuffix(sourceText) || `空标题第${String(itemIndex).padStart(2, "0")}项`;
  return `${base}｜新接口详情验证批次${runId}第${String(itemIndex).padStart(2, "0")}项`;
}

export function unwrapDetailContent(value) {
  if (typeof value !== "string") return { html: "", wrapper: null };
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && typeof parsed.json === "string") {
      return { html: parsed.json, wrapper: parsed };
    }
  } catch {}
  return { html: value, wrapper: null };
}

export function wrapDetailContent(html, wrapper) {
  if (!wrapper) return html;
  return JSON.stringify({ ...wrapper, json: html });
}

export function extractHeadingTokens(html) {
  const rows = [];
  const pattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/giu;
  for (const match of String(html ?? "").matchAll(pattern)) {
    rows.push({ level: `H${match[1]}`, text: normalizeText(match[2].replace(/<[^>]+>/gu, " ")) });
  }
  return rows;
}

export function buildDetailsLoadRequests({ pageType }) {
  const type = detailTypeForPageType(pageType);
  if (type === "PRODUCT") return [0, 1, 2, 3, 4].map((index) => ({ type, index }));
  return [{ type }];
}

export function buildDetailsUpdatePayload({ siteSettingId, pageUrl, type, loadRequest, data, content }) {
  const common = {
    siteSettingId,
    pageUrl,
    type,
    expectedVersion: data.version,
    expectedContentHash: data.contentHash,
  };
  if (type === "PRODUCT") {
    return {
      ...common,
      index: data.index ?? loadRequest.index,
      ...(data.productId ? { productId: data.productId } : {}),
      ...(data.editorUuid ? { editorUuid: data.editorUuid } : {}),
      content,
    };
  }
  return {
    ...common,
    ...(data.resourceId ? { resourceId: data.resourceId } : {}),
    detail: content,
  };
}

export function mapDetailHeadingsToLive(detailHeadings, liveHeadings) {
  const used = new Set();
  return detailHeadings.map((heading, detailIndex) => {
    let candidates = liveHeadings
      .map((live, liveIndex) => ({ live, liveIndex }))
      .filter(({ live, liveIndex }) => !used.has(liveIndex)
        && normalizeLevel(live.level) === normalizeLevel(heading.level)
        && normalizeText(live.text) === normalizeText(heading.text));
    let source = "live_text_level";
    if (candidates.length !== 1) {
      candidates = liveHeadings
        .map((live, liveIndex) => ({ live, liveIndex }))
        .filter(({ live, liveIndex }) => !used.has(liveIndex) && normalizeText(live.text) === normalizeText(heading.text));
      source = "live_unique_text";
    }
    if (candidates.length !== 1) {
      return { ...heading, detailIndex, liveIndex: -1, mappingStatus: "mapping_ambiguous", mappingSource: "" };
    }
    const [{ live, liveIndex }] = candidates;
    used.add(liveIndex);
    return { ...heading, detailIndex, liveIndex: Number.isInteger(live.index) ? live.index : liveIndex, mappingStatus: "mapped", mappingSource: source };
  });
}

export function expectedHeading({ originalLevel, originalText, runId, itemIndex }) {
  return {
    expectedLevel: nextHeadingLevel(normalizeLevel(originalLevel)),
    expectedText: makeDetailText({ sourceText: originalText, runId, itemIndex }),
  };
}

export function isDetailsUpdateSuccess(http, body) {
  if (http !== 200 || body?.code !== 200) return false;
  const status = String(body?.data?.status ?? "").toUpperCase();
  if (status) return /^(UPDATED|SUCCESS|SAVED|COMPLETED)(?:_|$)/u.test(status);
  return body?.data?.success === true;
}
