import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runId = process.argv[2] || "product-list-fresh-20260929-02";
assert.match(runId, /^[a-zA-Z0-9-]+$/, "Invalid run ID");
const stateFile = path.join(projectRoot, ".state/ai-lifecycle/runs", runId, "ai-product-list-settings/state.json");
const state = JSON.parse(await readFile(stateFile, "utf8"));
assert.equal(state.run_id, runId);

const record = state.type;
const checks = record.result_checks;
const settings = Object.fromEntries(record.settings.map((item) => [item.key, item]));
const settingKeys = ["product_scope", "sort", "loading", "page_size", "display_content", "base_color"];
assert(settingKeys.every((key) => settings[key]?.effect_status === "passed"), "Six effect checks are required");
assert(settingKeys.every((key) => settings[key]?.effect_reopened?.after_saved_preview === true), "Saved preview checks are required");
assert.equal(record.generation_status, "succeeded");
assert.equal(record.apply_status, "applied");
assert.equal(record.settings_status, "succeeded");
assert.equal(state.page.saved, true);
assert.equal(state.page.editor_verified, true);
assert.equal(state.page.preview_verified, true);
assert.equal(state.page.published_verified, true);
assert.equal(checks.preview.status, "passed");
assert.equal(checks.published.status, "passed");
assert.equal(checks.loading_flat.status, "skipped");

const category = record.category_phase.evidence;
assert.equal(category.exact_match, true);
assert.deepEqual([...category.visible_ids].sort(), [...category.expected_ids].sort());
const pagination = checks.loading_pagination.evidence;
const firstIds = pagination.first_page_ids;
const secondIds = pagination.second_page_ids;
assert.equal(firstIds.length, 5);
assert.equal(secondIds.length, 5);
assert.equal(new Set([...firstIds, ...secondIds]).size, 10);
assert.deepEqual([...firstIds, ...secondIds].sort(), record.catalog.products.map((item) => item.id).sort());
const published = checks.published.evidence;
assert.deepEqual(published.ids, firstIds);
assert.equal(published.pager_visible, true);
assert.equal(published.rating_visible, false);
const sortedNames = checks.sort.evidence.names;
assert.equal(sortedNames.length, 10);
const collator = new Intl.Collator("en", { sensitivity: "base" });
assert(sortedNames.every((name, index) => index === 0 || collator.compare(sortedNames[index - 1], name) <= 0));
const color = checks.base_color.evidence.rendered_colors[0];
assert.equal(color.replaceAll(" ", ""), checks.base_color.evidence.expected_color);
assert.equal(published.colors[0].replaceAll(" ", ""), color.replaceAll(" ", ""));

const publicUrl = new URL(state.page.publicUrl);
assert(["http:", "https:"].includes(publicUrl.protocol));
assert.equal(publicUrl.search, "");
const duration = record.total_run_duration_ms;
const durationLabel = `${Math.floor(duration / 60000)}分 ${Math.floor((duration % 60000) / 1000)}秒`;
const timeLabel = (value) => new Intl.DateTimeFormat("zh-CN", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
}).format(new Date(value));
const h = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const ids = (values) => values.map((value) => `<code>${h(value)}</code>`).join(" ");
const metric = (label, number, cls) => `<div class="metric"><span class="chip ${cls}">${label}</span><strong>${number}</strong></div>`;
const status = (label, detail) => `<div class="status-line"><span class="dot"></span><strong>${label}</strong><span>${detail}</span><b class="chip pass">通过</b></div>`;
const pageFooter = (number) => `<footer>AI product list regression report · ${number} / 4</footer>`;
const header = (title, subtitle) => `<div class="section-head"><span class="chip pass">通过</span><div><h2>${title}</h2><p>${subtitle}</p></div></div>`;

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>AI 产品列表设置回归报告 - ${h(runId)}</title><style>
  @page{size:A4;margin:0}*{box-sizing:border-box}html,body{margin:0;background:#fff;color:#223148;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Heiti SC",sans-serif;font-size:12px;line-height:1.55;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .page{position:relative;width:210mm;height:297mm;padding:17mm 16mm 15mm;break-after:page;overflow:hidden}.page:last-child{break-after:auto}
  h1{font-size:24px;line-height:1.25;margin:0 0 11px}h2{font-size:19px;line-height:1.25;margin:0}h3{font-size:15px;margin:0 0 8px}p{margin:5px 0}.muted{color:#61738d}.small{font-size:10.5px}.lead{font-size:13px;color:#34445a}
  .hero{border:1px solid #d6e3f4;border-radius:16px;padding:20px;background:#fff}.title-row{display:flex;align-items:center;gap:9px}.run-id{color:#5a7193;margin:3px 0 14px}.meta{display:grid;grid-template-columns:1fr 1fr;column-gap:24px;row-gap:7px;margin:13px 0 17px}.meta strong{font-weight:650}
  .chips{display:flex;gap:10px;margin-top:14px}.metric{flex:1;border:1px solid #dce5f1;border-radius:12px;padding:11px 10px;min-height:69px}.metric strong{display:block;font-size:23px;line-height:1.15;margin-top:7px}.chip{display:inline-block;border-radius:100px;padding:2px 9px;font-size:10px;font-weight:700;white-space:nowrap}.pass{color:#166534;background:#dcfce7}.fail{color:#991b1b;background:#fee2e2}.block{color:#9a3412;background:#ffedd5}.pending{color:#475569;background:#e2e8f0}
  .section-head{display:flex;align-items:flex-start;gap:11px;margin:2px 0 18px}.section-head p{color:#667992;margin-top:4px}.panel{border:1px solid #dbe5f1;border-radius:13px;padding:16px;margin-top:12px;break-inside:avoid}.panel.soft{background:#f8fbff}.panel h3{display:flex;justify-content:space-between;gap:10px}.result{color:#166534;font-weight:700}.rule{height:1px;background:#e5ecf5;margin:11px 0}.row{display:flex;justify-content:space-between;gap:18px;padding:5px 0;border-bottom:1px solid #edf1f6}.row:last-child{border-bottom:0}.row span:first-child{color:#64748b;flex:0 0 105px}.row span:last-child{text-align:right;flex:1;min-width:0;overflow-wrap:anywhere}
  .status-line{display:flex;align-items:center;gap:9px;padding:9px 3px;border-bottom:1px solid #e5ecf5}.status-line strong{min-width:92px}.status-line span:nth-of-type(2){flex:1;color:#51637b}.status-line .chip{margin-left:auto}.dot{width:8px;height:8px;border-radius:50%;background:#16a34a;flex-shrink:0}
  .note{border-left:3px solid #b9d4f3;padding:9px 12px;background:#f5f9ff;color:#4b607b;margin-top:12px}.warn{border-left-color:#f2be88;background:#fff8ef;color:#835024}.id-box{padding:9px 11px;background:#f4f7fb;border:1px solid #e3eaf3;border-radius:8px;margin-top:6px;line-height:2}code{font:10px/1.65 ui-monospace,SFMono-Regular,Menlo,monospace;background:#e7eef9;color:#315473;padding:2px 5px;border-radius:4px;margin-right:3px;white-space:nowrap}
  .two-col{display:grid;grid-template-columns:1fr 1fr;gap:12px}.two-col .panel{margin-top:0}.big-number{font-size:26px;font-weight:750;color:#173f7a}.link{color:#1663be;text-decoration:underline;word-break:break-all}.url-box{border:1px solid #bfd5ef;background:#f6faff;padding:12px;border-radius:8px;word-break:break-all;margin-top:8px}
  footer{position:absolute;bottom:9mm;left:16mm;right:16mm;text-align:center;color:#66758a;font-size:8px}.caption{color:#64748b;font-size:10px;margin-top:11px}.summary-table{width:100%;border-collapse:collapse;margin-top:10px}.summary-table td,.summary-table th{text-align:left;padding:8px 7px;border-bottom:1px solid #e3eaf2}.summary-table th{color:#63758e;font-size:11px}
</style></head><body>
<section class="page">
  <div class="hero"><div class="title-row"><h1>AI 产品列表设置回归测试报告</h1><span class="chip pass">通过</span></div>
    <div class="run-id">${h(runId)}</div>
    <div class="meta"><div>站点：<strong>${h(state.site_name)}</strong></div><div>语言：<strong>${h(state.site_language)}</strong></div>
      <div>开始：<strong>${h(timeLabel(record.last_run_started_at))}</strong></div><div>结束：<strong>${h(timeLabel(record.last_run_completed_at))}</strong></div>
      <div>累计执行耗时：<strong>${durationLabel}</strong></div><div>执行次数：<strong>${record.run_attempts} 次</strong></div>
      <div>业务测试点：<strong>6 个</strong></div><div>通过率：<strong>100%（已执行范围）</strong></div></div>
    <div class="chips">${metric("通过",6,"pass")}${metric("失败",0,"fail")}${metric("阻断",0,"block")}${metric("未覆盖",1,"pending")}</div>
  </div>
  <div class="panel soft" style="margin-top:24px"><h3>本轮结论 <span class="result">六项设置结果级验证通过</span></h3>
    <p class="lead">使用本轮新生成的产品列表区块，完成设置修改、保存后的预览复查和公开页展示验证。</p>
    <div class="rule"></div>
    ${status("生成与应用","新生成记录成功，区块已应用")}
    ${status("产品设置","六项设置均有渲染结果证据")}
    ${status("页面闭环","编辑器、保存、预览、发布均通过")}
  </div>
  <div class="note" style="margin-top:18px">统计口径：六项设置为业务测试点；“平铺模式”属于本轮未覆盖项，单列展示，不计入六项通过率。</div>
  ${pageFooter(1)}
</section>
<section class="page">
  ${header("设置结果 · 产品数据与排序","从站点后台产品目录建立对照，再检查保存后的列表内容")}
  <div class="panel"><h3>01　选择产品：指定分类 <span class="chip pass">通过</span></h3>
    <div class="row"><span>临时设置</span><span>指定分类 → ${h(record.category_phase.category)}</span></div>
    <div class="row"><span>后台预期</span><span>${category.expected_count} 个产品；ID ${ids(category.expected_ids)}</span></div>
    <div class="row"><span>保存后预览</span><span>${category.actual_count} 个产品；ID ${ids(category.visible_ids)}</span></div>
    <div class="row"><span>核对结果</span><span>实际 ID 与预期完全一致，其他 ${category.excluded_ids.length} 个产品未显示</span></div>
    <div class="note">分类验证完成后，产品范围恢复为“全部产品”；最终公开页面采用该设置。本轮没有验证公开页保持“测试分类”时的结果。</div>
  </div>
  <div class="panel"><h3>02　产品排序：名称升序 <span class="chip pass">通过</span></h3>
    <div class="row"><span>设置值</span><span>${h(settings.sort.selected)}</span></div>
    <div class="row"><span>预览结果</span><span>跨两页读取 ${sortedNames.length} 张卡片，名称顺序为升序</span></div>
    <div class="row"><span>首项名称</span><span>${h(sortedNames[0])}</span></div>
    <div class="row"><span>末项名称</span><span>${h(sortedNames.at(-1))}</span></div>
    <div class="row"><span>保存后复查</span><span>设置值与跨页排序结果保持一致</span></div>
  </div>
  <div class="panel soft"><h3>数据来源</h3><p>本站内容后台产品表共记录 ${record.catalog.products.length} 个产品，分类成员关系用于核对“测试分类”；预览卡片按产品 ID 与后台数据比对。</p>
    <p class="caption">后台分类筛选控件在本次采集时未加载，脚本改用后台产品表格中的逐产品分类字段交叉校验。</p></div>
  ${pageFooter(2)}
</section>
<section class="page">
  ${header("设置结果 · 分页与展示","核对实际卡片、翻页结果、字段显隐和计算后的颜色")}
  <div class="two-col">
    <div class="panel"><h3>03　加载方式 <span class="chip pass">通过</span></h3><p>最终设置为<strong>分页</strong>；预览可见页码，并成功切换到下一页。</p><p class="big-number">2 页</p><p class="muted small">第二页的产品 ID 与第一页不同。</p></div>
    <div class="panel"><h3>04　每页展示数量 <span class="chip pass">通过</span></h3><p>输入框设为 <strong>5</strong>；预览第一页 5 张、第二页 5 张。</p><p class="big-number">5 + 5</p><p class="muted small">两页合计 10 个不同 ID，与后台目录完全一致。</p></div>
  </div>
  <div class="panel"><h3>分页证据</h3>
    <p><strong>第一页：</strong></p><div class="id-box">${ids(firstIds)}</div>
    <p style="margin-top:11px"><strong>第二页：</strong></p><div class="id-box">${ids(secondIds)}</div>
    <p class="caption">公开页另核对第一页为 5 张卡片且显示分页控件；未在公开页点击第二页。</p>
  </div>
  <div class="panel"><h3>05　展示内容：星级评价 <span class="chip pass">通过</span></h3><p>将“星级评价”关闭。保存后预览卡片未显示评分；公开页第一页卡片也未显示评分。</p></div>
  <div class="panel"><h3>06　基础配色 <span class="chip pass">通过</span></h3><p>选择 <strong>${h(settings.base_color.selected)}</strong>；预览与公开页读取到的实际计算颜色均为 <strong>${h(color)}</strong>。</p>
    <div class="row"><span>修改前</span><span>${h(settings.base_color.effect_after.before)}</span></div><div class="row"><span>修改后</span><span>${h(color)}</span></div>
  </div>
  ${pageFooter(3)}
</section>
<section class="page">
  ${header("页面闭环与证据边界","保存、预览和发布后的验证结果")}
  <div class="panel"><h3>完整链路 <span class="chip pass">通过</span></h3>
    ${status("AI 生成","生成记录成功")}${status("区块应用","产品列表已进入编辑器")}${status("页面保存","保存成功并复查最终设置")}
    ${status("预览验证","跨两页核对 10 个产品及设置效果")}${status("发布验证","公开页第一页展示有效产品列表")}
  </div>
  <div class="panel"><h3>测试页面</h3><p>${h(state.page.name)}</p><div class="url-box"><a class="link" href="${h(publicUrl.href)}">${h(publicUrl.href)}</a></div></div>
  <div class="panel soft"><h3>覆盖范围说明</h3>
    <table class="summary-table"><thead><tr><th>位置</th><th>已核对内容</th><th>未核对内容</th></tr></thead><tbody>
      <tr><td>保存后预览</td><td>分类 1 个产品；最终两页各 5 个、跨页排序、评分隐藏、配色</td><td>无</td></tr>
      <tr><td>公开页面</td><td>第一页 5 个、分页控件、评分隐藏、配色</td><td>未点击公开页第二页</td></tr>
      <tr><td>加载方式</td><td>分页模式</td><td>平铺模式未覆盖</td></tr>
    </tbody></table>
  </div>
  <div class="note warn"><strong>未覆盖：平铺模式。</strong>本轮最终设置为分页，状态记录将平铺标记为 skipped；本报告不将其计为通过。</div>
  <p class="caption">依据：运行 ${h(runId)} 的自动化状态记录。报告只展示业务结果与必要证据，不含提示词、账号、密码或令牌。</p>
  ${pageFooter(4)}
</section></body></html>`;

const outputDir = path.join(projectRoot, "output/pdf");
await mkdir(outputDir, { recursive: true });
const outputFile = path.join(outputDir, `AI产品列表设置回归报告-${runId}.pdf`);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 794, height: 1123 }, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.pdf({ path: outputFile, format: "A4", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
} finally {
  await browser.close();
}
console.log(outputFile);
