import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.mjs";
import { closeHandles, openLiveManager } from "../src/live-fixtures.mjs";

const live = process.env.RUN_LIVE === "1";
const config = await loadConfig(process.env.LLMS_CONFIG ? new URL(`../${process.env.LLMS_CONFIG}`, import.meta.url).pathname : undefined);
const liveCase = { skip: !live, concurrency: false };

async function visibleErrors(manager) {
  return manager.content().locator(".llms-error:visible, .llms-save-error:visible").allTextContents();
}

test("TC-0006 自定义文件页签提供新增入口", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.editor.getByText("自定义txt文件", { exact: true }).last().click();
    const add = handles.editor.locator(".customize_file_add_file:visible");
    assert.equal(await add.isVisible(), true);
    await add.click();
    const visibleInputs = await handles.editor.locator("input:visible").evaluateAll((items) => items.map((item) => ({ placeholder: item.getAttribute("placeholder"), className: item.className })));
    assert.ok(visibleInputs.length > 0, "新增自定义文件弹层未出现可填写输入框");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0040 网站概述超过1000字符被拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.overviewInput().fill("x".repeat(1001));
    const errors = await visibleErrors(handles.manager);
    assert.ok(errors.length > 0 || (await handles.manager.saveButton().getAttribute("aria-disabled")) === "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0041 网站概述拒绝HTML和脚本文本", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.overviewInput().fill("<script>alert(1)</script>");
    const errors = await visibleErrors(handles.manager);
    assert.ok(errors.length > 0 || (await handles.manager.saveButton().getAttribute("aria-disabled")) === "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0044 扩展字段名称超过100字符被拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("system");
    await handles.manager.addExtraField("n".repeat(101), "value");
    const errors = await visibleErrors(handles.manager);
    assert.ok(errors.length > 0 || (await handles.manager.saveButton().getAttribute("aria-disabled")) === "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0045 扩展字段名称重复被拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("system");
    await handles.manager.addExtraField("DuplicateField", "one");
    await handles.manager.addExtraField("duplicatefield", "two");
    const errors = await visibleErrors(handles.manager);
    assert.ok(errors.length > 0 || (await handles.manager.saveButton().getAttribute("aria-disabled")) === "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0046 扩展字段内容超过500字符被拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("system");
    await handles.manager.addExtraField("LengthField", "v".repeat(501));
    const errors = await visibleErrors(handles.manager);
    assert.ok(errors.length > 0 || (await handles.manager.saveButton().getAttribute("aria-disabled")) === "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0047 扩展字段达到20个后禁止继续添加", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("system");
    for (let index = 0; index < 20; index += 1) await handles.manager.addExtraField(`Field_${index}`, `Value_${index}`);
    assert.equal(await handles.manager.content().locator(".llms-extra-fields .llms-extra-controls").count(), 20);
    assert.equal(await handles.manager.addField().getAttribute("aria-disabled"), "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0049 自定义内容超过100000字符被拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("custom");
    await handles.manager.customTextarea().fill("c".repeat(100001));
    const errors = await visibleErrors(handles.manager);
    assert.ok(errors.length > 0 || (await handles.manager.saveButton().getAttribute("aria-disabled")) === "true");
  } finally {
    await closeHandles(handles);
  }
});

test("TC-0052 多个错误时保存被拦截", liveCase, async () => {
  const handles = await openLiveManager(config);
  try {
    await handles.manager.switchToSource("system");
    await handles.manager.overviewInput().fill("<script>bad</script>");
    await handles.manager.addExtraField("OnlyName", "");
    assert.equal(await handles.manager.saveButton().getAttribute("aria-disabled"), "true");
  } finally {
    await closeHandles(handles);
  }
});
