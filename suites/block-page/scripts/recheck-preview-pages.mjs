import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const runId = "20260824130303";
const pagesDir = path.join(root, ".state/growth-engine-h-v3-full-pages", runId);
const out = path.join(root, "reports/growth-engine-h-v3-full-batch", runId, "preview-recheck.json");
const decode = (s) => String(s ?? "").replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&lt;/gu, "<").replace(/&gt;/gu, ">").replace(/&quot;/gu, '"').replace(/&#39;/gu, "'");
const clean = (s) => decode(String(s ?? "").replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim());
const stripSync = (s) => clean(s).replace(/｜同步验证批次\d+第\d+项$/u, "");
const fetchWithTimeout = async (url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    return { status: response.status, body: await response.text(), url: response.url };
  } finally { clearTimeout(timer); }
};
const readPage = async (file) => JSON.parse(await readFile(path.join(pagesDir, file), "utf8"));
const files = (await (await import("node:fs/promises")).readdir(pagesDir)).filter((f) => f.endsWith(".json"));
const results = [];
for (const file of files) {
  const page = await readPage(file);
  const preview = page.preview_url || page.public_url || "";
  const fallback = preview.replace(".preview.leadong.com", ".ldmfyh.com");
  let response;
  let previewStatus = 0;
  let source = preview;
  let error = "";
  try { response = await fetchWithTimeout(preview); previewStatus = response.status; } catch (e) { error = `${e.name}: ${e.message}`; }
  if (!response || response.status >= 400) {
    try { response = await fetchWithTimeout(fallback); source = fallback; } catch (e) { error = `${e.name}: ${e.message}`; }
  }
  const body = response?.body || "";
  const headings = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/giu;
  let match;
  while ((match = re.exec(body))) headings.push({ level: `H${match[1]}`, text: clean(match[2]) });
  const itemResults = (page.items || []).filter((i) => i.level_editable !== false && i.text_editable !== false).map((item) => {
    const expected = clean(item.expected_text);
    const candidates = headings.filter((h) => h.text === expected || h.text.includes(expected));
    return { item_index: item.item_index, block_id: item.editor_setting_id || "", expected_level: item.expected_level, expected_text: expected, matches: candidates, status: candidates.length === 1 && candidates[0].level === item.expected_level ? "verified" : candidates.length === 0 ? "missing" : "mismatch" };
  });
  const previewAvailable = previewStatus > 0 && previewStatus < 400;
  results.push({ page_path: page.page_path, preview_url: preview, checked_url: source, preview_http_status: previewStatus, fallback_http_status: source === fallback ? response?.status ?? 0 : 0, http_status: response?.status ?? 0, heading_count: headings.length, headings, item_results: itemResults, status: !previewAvailable ? "preview_unavailable" : (itemResults.every((i) => i.status === "verified" || !i.expected_text) ? "verified" : "mismatch"), error: !previewAvailable ? `${error ? `${error}；` : ""}预览域名不可访问，当前结果来自公开域名回退，仅供页面可达性参考` : error });
}
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, JSON.stringify({ run_id: runId, generated_at: new Date().toISOString(), pages: results }, null, 2));
const summary = results.reduce((a, r) => { a.pages += 1; a[r.status] = (a[r.status] || 0) + 1; a.items += r.item_results.length; for (const i of r.item_results) a[`item_${i.status}`] = (a[`item_${i.status}`] || 0) + 1; return a; }, { pages: 0, items: 0 });
console.log(JSON.stringify({ out, summary }, null, 2));
