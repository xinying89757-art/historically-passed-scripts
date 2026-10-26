#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "../src/config.mjs";

const root = projectRoot;
const readJson = async (file) => JSON.parse(await readFile(path.join(root, file), "utf8"));
const componentState = await readJson(".state/component-run-state.json");
const fullState = await readJson(".state/v3-full-heading-state.json");
const rankingState = await readJson(".state/ranking-heading-run-state.json");
const pages = new Map();

function addPage(record, scope, siteName, editorSiteName, sourceEntries, blockStateFile = ".state/v3-full-heading-state.json") {
  const pageUrl = record.page_url || record.publicUrl;
  if (!pageUrl || !sourceEntries.length) return;
  const parsed = new URL(pageUrl);
  const key = `${parsed.origin}${parsed.pathname}`;
  let page = pages.get(key);
  if (!page) {
    page = {
      id: `expand-${scope}-${String(pages.size + 1).padStart(3, "0")}`,
      pageName: record.page_name || record.name,
      pagePath: parsed.pathname,
      pageUrl: key,
      growthEngineSiteName: siteName,
      growthEngineSiteHost: parsed.host,
      editorSiteName,
      editorSiteLanguage: "英语",
      scope,
      blockStateFile,
      scenarios: [],
      allowedSources: [],
    };
    pages.set(key, page);
  }
  for (const entry of sourceEntries) {
    const sourceText = String(entry.sourceText ?? "").trim();
    if (!sourceText) continue;
    page.allowedSources.push({
      sourceText,
      scenario: "both",
      objectId: entry.objectId ?? "",
      objectName: entry.objectName ?? "",
      sourceKind: entry.sourceKind ?? "",
    });
  }
}

for (const record of componentState.records.filter((entry) => entry.status === "configured")) {
  const entries = [];
  if (record.actual_title) entries.push({ sourceText: record.actual_title, objectId: record.setting_id, objectName: record.original_name, sourceKind: "component_title" });
  for (const heading of record.actual_headings ?? []) {
    entries.push({ sourceText: heading.text, objectId: record.setting_id, objectName: record.original_name, sourceKind: heading.editor_key || "component_rich_text" });
  }
  // Component test pages are maintained in the separate 3.0 component site.
  // Normalize the source URL (the editor inventory was recorded on the
  // nanjing host) so the Growth Engine/API target is the matching site.
  const componentUrl = new URL(record.page_url || record.publicUrl);
  componentUrl.protocol = "http:";
  componentUrl.host = "site.example.invalid";
  addPage({ ...record, publicUrl: componentUrl.toString(), page_url: componentUrl.toString() }, "components", "3.0区块+组件", "测试增长引擎", entries);
}

function blockEntries(record) {
  const headings = (record.heading_results?.length ? record.heading_results : record.heading_poc) ?? [];
  const seen = new Set();
  return headings.flatMap((heading) => {
    const sourceText = String(heading.text ?? "").trim();
    if (!sourceText || seen.has(sourceText)) return [];
    seen.add(sourceText);
    return [{ sourceText, objectId: record.block_id, objectName: record.app_name, sourceKind: heading.kind || "block_heading" }];
  });
}

for (const record of fullState.records.filter((entry) => entry.heading_status === "configured_verified")) {
  addPage(record, "blocks", "全量3.0区块", "nanjing", blockEntries(record));
}
for (const record of rankingState.records.filter((entry) => ["configured", "partial_configured"].includes(entry.heading_status))) {
  addPage(record, "blocks", "全量3.0区块", "nanjing", blockEntries(record), ".state/ranking-heading-run-state.json");
}

const targets = [...pages.values()].map((page) => {
  const counts = new Map();
  for (const source of page.allowedSources) counts.set(source.sourceText, (counts.get(source.sourceText) ?? 0) + 1);
  page.allowedSources = page.allowedSources.filter((source) => counts.get(source.sourceText) === 1);
  return page;
});

const config = {
  loginUrl: "https://admin.example.invalid/website.html",
  growthEngineUrl: "https://admin.example.invalid/phoenix2/composite/middle/platform/index.html#/other?parmas=iframe&text=geo_growth_engine&isMoliAIIsall=0",
  apiBaseUrl: "https://admin.example.invalid/geoEngine/api/onpageOpenApi",
  userId: 20085168,
  proxyServer: "http://proxy.example.invalid:8080",
  browser: { channel: "chrome", headless: false, startMinimized: true, slowMo: 80, locale: "zh-CN" },
  timeouts: { actionMs: 20000, navigationMs: 60000, syncMs: 90000, liveMs: 120000, livePollMs: 3000 },
  paths: {
    userDataDir: ".auth/growth-engine-h",
    stateFile: ".state/onpage-agent-h-v3-expansion-state.json",
    artifactsDir: "artifacts/onpage-agent-h-v3-expansion",
    reportsDir: "reports/onpage-agent-h-v3-expansion",
  },
  sourceFiles: { componentStateFile: ".state/component-run-state.json", blockStateFile: ".state/v3-full-heading-state.json" },
  targets,
};
await writeFile(path.join(root, "config/onpage-agent-h-v3-expansion.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ pages: targets.length, allowedSources: targets.reduce((n, target) => n + target.allowedSources.length, 0), output: "config/onpage-agent-h-v3-expansion.json" }, null, 2));
