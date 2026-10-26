import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import {
  buildCustomCodeHeadings,
  buildCustomCodeHtml,
  buildRichTextDialogPlan,
  readComponentWorkbook,
  splitComponentNames,
} from "../src/component-input.mjs";

const workbookPath = process.env.COMPONENT_WORKBOOK || "input/components.xlsx";

test("拆分一个单元格内的多个引号组件名称", () => {
  assert.deepEqual(splitComponentNames("“FAQ列表”组件、“滚动FAQ”组件"), [
    "FAQ列表",
    "滚动FAQ",
  ]);
});

test("一期清单生成 67 个唯一组件和 60 个目标", async (t) => {
  if (!existsSync(workbookPath)) {
    t.skip(`未提供组件工作簿：${workbookPath}`);
    return;
  }
  const input = await readComponentWorkbook(workbookPath, "一期清单");
  assert.equal(input.records.length, 67);
  assert.equal(input.targetRecords.length, 60);
  assert.equal(input.counts.skipped_detail, 3);
  assert.equal(input.counts.skipped_h_unsupported, 4);
  assert.equal(input.duplicates.length, 2);
  assert.deepEqual(
    input.targetRecords.slice(0, 6).map((record) => record.original_name),
    ["快速导航", "图片集", "文本", "图文展示", "分享", "滚动图片"],
  );
  assert.equal(
    input.records.find((record) => record.original_name === "FAQ列表")
      .chinese_name,
    "常见问题列表",
  );
  assert.equal(
    input.records.find((record) => record.original_name === "LOGO").chinese_name,
    "网站标志",
  );
  const standard = input.targetRecords.filter(
    (record) => record.component_kind === "standard",
  );
  const customCode = input.targetRecords.filter(
    (record) => record.component_kind === "custom_code",
  );
  const richText = input.targetRecords.filter(
    (record) => record.component_kind === "rich_text_dialog",
  );
  assert.equal(customCode.length, 10);
  assert.equal(richText.length, 3);
  assert.ok(
    standard.every(
      (record) =>
        record.expected_level === "H2" &&
        !/[A-Za-z]/.test(record.expected_title),
    ),
  );
  assert.ok(
    customCode.every(
      (record) =>
        record.expected_title === "" &&
        record.expected_level === "" &&
        record.expected_heading_count === 5 &&
        record.expected_headings.map(({ level }) => level).join(",") ===
          "H2,H3,H4,H5,H6" &&
        !/[A-Za-z]/.test(
          record.expected_headings.map(({ text }) => text).join(""),
        ),
    ),
  );
  const pluginCode = customCode.find(
    (record) => record.original_name === "插件代码",
  );
  assert.equal(pluginCode.sequence, 50);
  assert.equal(
    pluginCode.expected_code,
    [
      "<h2>组件代码测试-050-插件代码-二级标题</h2>",
      "<h3>组件代码测试-050-插件代码-三级标题</h3>",
      "<h4>组件代码测试-050-插件代码-四级标题</h4>",
      "<h5>组件代码测试-050-插件代码-五级标题</h5>",
      "<h6>组件代码测试-050-插件代码-六级标题</h6>",
    ].join("\n"),
  );
  assert.deepEqual(
    richText.map((record) => ({
      name: record.original_name,
      sequence: record.sequence,
      headingCount: record.expected_heading_count,
    })),
    [
      { name: "图文页签", sequence: 15, headingCount: 1 },
      { name: "公告", sequence: 16, headingCount: 1 },
      { name: "倒计时", sequence: 18, headingCount: 2 },
    ],
  );
});

test("自定义代码生成器只生成 H2 到 H6", () => {
  const headings = buildCustomCodeHeadings(50, "插件代码");
  assert.deepEqual(
    headings.map(({ level }) => level),
    ["H2", "H3", "H4", "H5", "H6"],
  );
  const code = buildCustomCodeHtml(headings);
  assert.doesNotMatch(code, /<h1[> ]/i);
  assert.equal((code.match(/<h[2-6]>/gi) ?? []).length, 5);
});

test("富文本组件生成唯一中文 H2 测试数据", () => {
  const tabs = buildRichTextDialogPlan("图文页签", 15);
  const announcement = buildRichTextDialogPlan("公告", 16);
  const countdown = buildRichTextDialogPlan("倒计时", 18);
  assert.equal(tabs.expectedTabTitle, "图文页签测试项-015");
  assert.equal(tabs.expectedEditors[0].text, "组件内容测试-015-图文页签");
  assert.equal(announcement.expectedTitle, "组件标题测试-016-公告");
  assert.equal(announcement.expectedEditors[0].level, "H2");
  assert.equal(countdown.expectedEditors.length, 2);
  assert.deepEqual(countdown.requiredTokens, ["{countdown}"]);
  assert.ok(
    [tabs, announcement, countdown]
      .flatMap((plan) => plan.expectedEditors)
      .every((editor) => !/[A-Za-z]/.test(editor.text)),
  );
});
