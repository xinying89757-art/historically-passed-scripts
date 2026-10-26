import assert from "node:assert/strict";
import test from "node:test";
import {
  auditCustomCodeValue,
  auditRichTextDialogValue,
  extractHeadingsFromHtml,
  futureEndDate,
} from "../src/component-editor.mjs";

const expectedHeadings = [
  { level: "H2", text: "组件代码测试-050-插件代码-二级标题" },
  { level: "H3", text: "组件代码测试-050-插件代码-三级标题" },
  { level: "H4", text: "组件代码测试-050-插件代码-四级标题" },
  { level: "H5", text: "组件代码测试-050-插件代码-五级标题" },
  { level: "H6", text: "组件代码测试-050-插件代码-六级标题" },
];
const expectedCode = expectedHeadings
  .map(({ level, text }) => `<${level.toLowerCase()}>${text}</${level.toLowerCase()}>`)
  .join("\n");

test("代码审计按 DOM 顺序解析 H2 到 H6", () => {
  assert.deepEqual(extractHeadingsFromHtml(expectedCode), expectedHeadings);
  const audit = auditCustomCodeValue({
    actualCode: expectedCode,
    actualTitle: "",
    expectedCode,
    expectedHeadings,
  });
  assert.equal(audit.ok, true);
  assert.equal(audit.heading_count, 5);
});

test("代码审计拒绝非空组件标题、额外 H1 或代码差异", () => {
  for (const input of [
    { actualTitle: "不应存在的标题", actualCode: expectedCode },
    { actualTitle: "", actualCode: `<h1>额外标题</h1>\n${expectedCode}` },
    { actualTitle: "", actualCode: expectedCode.replace("二级标题", "已改动") },
  ]) {
    const audit = auditCustomCodeValue({
      ...input,
      expectedCode,
      expectedHeadings,
    });
    assert.equal(audit.ok, false);
    assert.ok(audit.reason);
  }
});

test("富文本审计逐输入框验证 H2 和倒计时占位符", () => {
  const record = {
    expected_title: "",
    expected_tab_title: "",
    expected_editors: [
      {
        key: "countdown_active",
        text: "组件内容测试-018-倒计时-进行中",
        level: "H2",
        required_tokens: ["{countdown}"],
      },
      {
        key: "countdown_finished",
        text: "组件内容测试-018-倒计时-已结束",
        level: "H2",
        required_tokens: [],
      },
    ],
    required_tokens: ["{countdown}"],
    end_date_strategy: "today_plus_30_days",
    end_date: "2026-09-13 23:59:59",
  };
  const audit = auditRichTextDialogValue(record, {
    title: "",
    tabTitle: "",
    editors: [
      {
        key: "countdown_active",
        html: "<h2>组件内容测试-018-倒计时-进行中</h2><p>{countdown}</p>",
      },
      {
        key: "countdown_finished",
        html: "<h2>组件内容测试-018-倒计时-已结束</h2>",
      },
    ],
    endDate: "2026-09-13 23:59:59",
  });
  assert.equal(audit.ok, true);
  assert.equal(audit.heading_count, 2);
  assert.deepEqual(audit.actual_tokens, [
    { token: "{countdown}", count: 1 },
  ]);
});

test("富文本审计拒绝跨输入框串改、额外标题及占位符重复", () => {
  const record = {
    expected_title: "",
    expected_tab_title: "图文页签测试项-015",
    expected_editors: [
      {
        key: "graphic_tab_content",
        text: "组件内容测试-015-图文页签",
        level: "H2",
        required_tokens: [],
      },
    ],
    required_tokens: [],
    end_date_strategy: "",
    end_date: "",
  };
  const audit = auditRichTextDialogValue(record, {
    title: "",
    tabTitle: "错误页签",
    editors: [
      {
        key: "graphic_tab_content",
        html: "<h2>组件内容测试-015-图文页签</h2><h3>额外标题</h3>",
      },
    ],
    endDate: "",
  });
  assert.equal(audit.ok, false);
  assert.match(audit.reason, /页签名称回填不一致/);
  assert.match(audit.reason, /H标签不一致/);
});

test("未来结束日期固定到第30天23点59分59秒", () => {
  assert.equal(
    futureEndDate(new Date(2026, 7, 14, 10, 0, 0), 30),
    "2026-09-13 23:59:59",
  );
});
