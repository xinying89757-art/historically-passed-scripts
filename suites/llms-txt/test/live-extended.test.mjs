import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import {
  assertPublicEventually,
  closeHandles,
  openLiveManager,
  openManager,
  publicFile,
  restoreState,
  uniqueMarker
} from "../src/live-fixtures.mjs";
import { launchProxyContext } from "../src/browser.mjs";

const live = process.env.RUN_LIVE === "1";
const config = await loadConfig(process.env.LLMS_CONFIG ? new URL(`../${process.env.LLMS_CONFIG}`, import.meta.url).pathname : undefined);
const liveCase = { skip: !live, concurrency: false };

async function finish(handles, baseline) {
  let restoreError;
  try {
    if (baseline && process.env.CLEANUP_LIVE_RESULTS !== "0") await restoreState(config, handles.context, baseline);
  } catch (error) {
    restoreError = error;
  } finally {
    await closeHandles(handles);
  }
  if (restoreError) throw restoreError;
}

test("TC-0001 有权限账号显示管理txt文件入口", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.settingsEntry().click().catch(() => {});
    assert.equal(await handles.manager.manageEntry().isVisible(), true);
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0005 切换自定义txt文件页签", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.editor.getByText("自定义txt文件", { exact: true }).last().click();
    assert.equal(await handles.editor.locator(".customize-file-custom-panel:visible").count(), 1);
    assert.equal(await handles.manager.cancelButton().isVisible(), true);
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0016 悬停问号显示自动生成规则", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.content().locator(".llms-rule-help").hover();
    const tooltip = handles.manager.content().locator(".llms-rule-tooltip:visible");
    await tooltip.waitFor({ state: "visible", timeout: 3000 });
    assert.match(await tooltip.innerText(), /网站标题.*网站概述.*FAQ/u);
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0039 网站概述显示选填说明并允许空值", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    assert.match(await handles.manager.content().innerText(), /网站概述.*选填/u);
    await handles.manager.overviewInput().fill("");
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status() ?? 200, 200, result.body);
    assert.equal(result.closed, true);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0043 扩展字段仅填写名称时拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("system");
    await handles.manager.addExtraField(uniqueMarker("FIELD_NAME"), "");
    assert.equal(await handles.manager.saveButton().getAttribute("aria-disabled"), "true");
    assert.equal(await handles.manager.content().isVisible(), true);
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0048 自定义内容为空时拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("custom");
    await handles.manager.customTextarea().fill("   ");
    assert.equal(await handles.manager.saveButton().getAttribute("aria-disabled"), "true");
    assert.ok((await handles.manager.content().innerText()).includes("请填写自定义 llms.txt 内容"));
    assert.equal(await handles.manager.content().isVisible(), true);
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0051 功能关闭时隐藏配置并跳过字段校验", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.setEnabled(false);
    assert.equal(await handles.manager.content().locator(".llms-system-fields").isVisible(), false);
    assert.equal(await handles.manager.customTextarea().isVisible(), false);
  } finally {
    await handles.manager.closeWithoutSaving();
    await closeHandles(handles);
  }
});

test("TC-0053 未修改配置直接保存时关闭弹窗", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status() ?? 200, 200, result.body);
    assert.equal(result.closed, true);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0057 无扩展字段时可保存", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    await handles.manager.switchToSource("system");
    await handles.manager.removeExtraFields();
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status() ?? 200, 200, result.body);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0061 未命中存量文件的站点保持默认开启和系统生成", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const state = await handles.manager.readState();
    assert.equal(state.enabled, true);
    assert.equal(state.source, "system");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0009 关闭但不保存时公开文件不变", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    assert.equal(baseline.enabled, true, "当前站点不是开启状态，无法验证未保存关闭");
    const before = await publicFile(config, handles.context, "before_unsaved_close");
    await before.page.close();
    await handles.manager.setEnabled(false);
    assert.equal(await handles.manager.content().locator(".llms-system-fields").isVisible(), false);
    const after = await publicFile(config, handles.context, "after_unsaved_close");
    await after.page.close();
    assert.equal(after.status, before.status);
  } finally {
    if (await handles.manager.content().isVisible().catch(() => false)) await handles.manager.closeWithoutSaving();
    await closeHandles(handles);
  }
});

test("TC-0010 关闭并保存后公开文件返回404且配置可恢复", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    assert.equal(baseline.enabled, true, "当前站点不是开启状态，无法验证关闭");
    await handles.manager.setEnabled(false);
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status(), 200, result.body);
    const missing = await assertPublicEventually(config, handles.context, 404, { suffix: "disabled" });
    assert.equal(missing.status, 404);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0011 重新开启并保存后按关闭前配置恢复", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  const marker = uniqueMarker("RESTORE");
  try {
    baseline = await handles.manager.readState();
    assert.equal(baseline.enabled, true, "当前站点不是开启状态，无法验证恢复");
    await handles.manager.switchToSource("system");
    await handles.manager.overviewInput().fill(marker);
    await handles.manager.saveAndWait();
    await assertPublicEventually(config, handles.context, (x) => x.status === 200 && x.body.includes(marker), { suffix: "restore_on" });
    let next = await openManager(config, handles.context);
    await next.manager.setEnabled(false);
    await next.manager.saveAndWait();
    await next.editor.close().catch(() => {}); await next.platform.close().catch(() => {});
    await assertPublicEventually(config, handles.context, 404, { suffix: "restore_off" });
    next = await openManager(config, handles.context);
    assert.equal(await next.manager.overviewInput().inputValue(), marker);
    await next.manager.setEnabled(true);
    await next.manager.saveAndWait();
    await next.editor.close().catch(() => {}); await next.platform.close().catch(() => {});
    const restored = await assertPublicEventually(config, handles.context, (x) => x.status === 200 && x.body.includes(marker), { suffix: "restore_on_again" });
    assert.equal(restored.status, 200);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0013 无根目录冲突时关闭转开启生成文件", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    await handles.manager.setEnabled(false);
    await handles.manager.saveAndWait();
    await assertPublicEventually(config, handles.context, 404, { suffix: "no_conflict_off" });
    const next = await openManager(config, handles.context);
    await next.manager.setEnabled(true);
    const result = await next.manager.saveAndWait();
    assert.equal(result.response?.status(), 200, result.body);
    await next.editor.close().catch(() => {}); await next.platform.close().catch(() => {});
    assert.equal((await assertPublicEventually(config, handles.context, 200, { suffix: "no_conflict_on" })).status, 200);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0014 已开启状态保存配置不被自身文件阻断", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    assert.equal(baseline.enabled, true);
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status() ?? 200, 200, result.body);
    if (result.response) assert.match(result.body, /success/u);
    assert.equal((await assertPublicEventually(config, handles.context, 200, { suffix: "self_file" })).status, 200);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0018 首次切换自定义内容带入当前生成内容", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("custom");
    assert.ok((await handles.manager.customTextarea().inputValue()).trim().length > 0);
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0019 往返切换保留自定义文本", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const marker = uniqueMarker("ROUNDTRIP");
    await handles.manager.switchToSource("custom");
    await handles.manager.customTextarea().fill(`# ${marker}`);
    await handles.manager.switchToSource("system");
    await handles.manager.switchToSource("custom");
    assert.equal(await handles.manager.customTextarea().inputValue(), `# ${marker}`);
  } finally {
    await handles.manager.closeWithoutSaving();
    await closeHandles(handles);
  }
});

test("TC-0020 自动生成文件模块顺序正确", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const result = await publicFile(config, handles.context, "module_order");
    assert.equal(result.status, 200);
    const expectedOrder = ["## Website Language Versions", "## Website Navigation", "## Product Category", "## FAQ"];
    const positions = expectedOrder.map((heading) => result.body.indexOf(heading)).filter((position) => position >= 0);
    assert.ok(positions.length >= 2, "公开文件中可用于排序校验的模块不足");
    assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
    await result.page.close();
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0023/0024 概述为空时使用空态说明并省略概述模块", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const state = await handles.manager.readState();
    assert.equal(state.source, "system");
    assert.equal(await handles.manager.overviewInput().inputValue(), "");
    assert.match(await handles.manager.content().innerText(), /首页 Meta Description 为空/u);
    const result = await publicFile(config, handles.context, "empty_summary");
    assert.equal(result.status, 200);
    assert.equal(/^## Website Overview$/mu.test(result.body), false);
    await result.page.close();
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0028 语言版本模块包含当前站点和专站", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const result = await publicFile(config, handles.context, "language_versions");
    assert.equal(result.status, 200);
    assert.match(result.body, /## Website Language Versions/u);
    assert.match(result.body, /- \[English\]/u);
    assert.match(result.body, /- \[Chinese\]/u);
    await result.page.close();
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0029 导航模块保留菜单层级", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const result = await publicFile(config, handles.context, "navigation_tree");
    assert.equal(result.status, 200);
    const products = result.body.indexOf("- [Products]");
    const inverters = result.body.indexOf("    - [Inverters]");
    assert.ok(products >= 0 && inverters > products);
    await result.page.close();
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0030 产品分类模块保留分类层级", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const result = await publicFile(config, handles.context, "product_categories");
    assert.equal(result.status, 200);
    const rawBody = await result.page.locator("body").textContent();
    const category = rawBody.indexOf("## Product Category");
    const child = rawBody.lastIndexOf("    - [Central Inverters");
    assert.ok(category >= 0 && child > category);
    await result.page.close();
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0035 英文站系统模块使用英文标题", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    const result = await publicFile(config, handles.context, "english_headings");
    assert.equal(result.status, 200);
    assert.match(result.body, /## Website Navigation/u);
    assert.match(result.body, /## Product Category/u);
    assert.equal(result.body.includes("## 网站导航"), false);
    await result.page.close();
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0022 本页网站概述优先于首页Meta Description", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  const marker = uniqueMarker("SUMMARY");
  try {
    baseline = await handles.manager.readState();
    await handles.manager.switchToSource("system");
    await handles.manager.overviewInput().fill(marker);
    await handles.manager.saveAndWait();
    const result = await assertPublicEventually(config, handles.context, (x) => x.status === 200 && x.body.includes(marker), { suffix: "summary_priority" });
    assert.equal(result.status, 200);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0025 扩展字段保存后输出到公开文件", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  const name = uniqueMarker("FIELD");
  const value = uniqueMarker("VALUE");
  try {
    baseline = await handles.manager.readState();
    await handles.manager.switchToSource("system");
    await handles.manager.removeExtraFields();
    await handles.manager.addExtraField(name, value);
    await handles.manager.saveAndWait();
    const result = await assertPublicEventually(config, handles.context, (x) => x.status === 200 && x.body.includes(name) && x.body.includes(value), { suffix: "extra_field" });
    assert.equal(result.status, 200);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0036 保存配置后无需发布即可更新公开文件", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  const marker = uniqueMarker("NO_PUBLISH");
  try {
    baseline = await handles.manager.readState();
    await handles.manager.switchToSource("system");
    await handles.manager.overviewInput().fill(marker);
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status(), 200, result.body);
    const publicResult = await assertPublicEventually(config, handles.context, (x) => x.status === 200 && x.body.includes(marker), { suffix: "no_publish" });
    assert.equal(publicResult.status, 200);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0054 开启状态保存成功并自动关闭", liveCase, async () => {
  const handles = await openLiveManager(config);
  let baseline;
  try {
    baseline = await handles.manager.readState();
    await handles.manager.setEnabled(true);
    const result = await handles.manager.saveAndWait();
    assert.equal(result.response?.status() ?? 200, 200, result.body);
    assert.equal(result.closed, true);
  } finally {
    await finish(handles, baseline);
  }
});

test("TC-0056 双窗口先后保存以最后成功配置为准", liveCase, async () => {
  const first = await openLiveManager(config);
  const context = first.context;
  const second = await openManager(config, context);
  let baseline;
  const firstMarker = uniqueMarker("WINDOW_A");
  const secondMarker = uniqueMarker("WINDOW_B");
  try {
    baseline = await first.manager.readState();
    await first.manager.switchToSource("system");
    await first.manager.overviewInput().fill(firstMarker);
    await first.manager.saveAndWait();
    await second.manager.switchToSource("system");
    await second.manager.overviewInput().fill(secondMarker);
    await second.manager.saveAndWait();
    const result = await assertPublicEventually(config, context, (x) => x.status === 200 && x.body.includes(secondMarker), { suffix: "last_window" });
    assert.equal(result.status, 200);
    assert.equal(result.body.includes(firstMarker), false);
  } finally {
    await first.editor.close().catch(() => {}); await first.platform.close().catch(() => {});
    await second.editor.close().catch(() => {}); await second.platform.close().catch(() => {});
    if (process.env.CLEANUP_LIVE_RESULTS !== "0") await restoreState(config, context, baseline);
    await context.close();
  }
});

test("TC-0055 保存处理中禁用重复提交、取消和关闭", { skip: "需要测试环境提供可控的保存延迟", concurrency: false }, async () => {});
test("TC-0002 无权限账号不显示入口", { skip: "需要无网站设置权限账号", concurrency: false }, async () => {});
test("TC-0063 主站与小语种专站隔离", { skip: "当前仅配置了英语站点，缺少可操作的主站/小语种站点组合", concurrency: false }, async () => {});
