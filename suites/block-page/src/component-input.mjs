import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SpreadsheetFile } from "@oai/artifact-tool";

const CHINESE_TITLE_NAMES = new Map([
  ["LOGO", "网站标志"],
  ["Google地图", "谷歌地图"],
  ["FAQ列表", "常见问题列表"],
  ["滚动FAQ", "滚动常见问题"],
  ["FAQ分类", "常见问题分类"],
  ["FAQ搜索", "常见问题搜索"],
  ["VR展示", "虚拟现实展示"],
  ["Twitter插件", "推特插件"],
  ["Facebook插件", "脸书插件"],
  ["Facebook Messenger插件", "脸书消息插件"],
  ["Tawk.to在线客服", "第三方在线客服"],
  ["Facebook直播", "脸书直播"],
  ["自定义HTML", "自定义网页代码"],
  ["MailChimp", "邮件营销插件"],
]);

const DETAIL_NAMES = new Set(["产品详情", "文章详情", "视频详情"]);

const CUSTOM_CODE_COMPONENTS = new Set([
  "插件代码",
  "在线客服",
  "VR展示",
  "Twitter插件",
  "Facebook插件",
  "Facebook Messenger插件",
  "Tawk.to在线客服",
  "Facebook直播",
  "自定义HTML",
  "MailChimp",
]);

const RICH_TEXT_DIALOG_COMPONENTS = new Set([
  "图文页签",
  "公告",
  "倒计时",
]);

const CUSTOM_CODE_LEVEL_NAMES = new Map([
  [2, "二级标题"],
  [3, "三级标题"],
  [4, "四级标题"],
  [5, "五级标题"],
  [6, "六级标题"],
]);

function normalizeCell(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

export function splitComponentNames(value) {
  const text = normalizeCell(value);
  const quoted = [...text.matchAll(/[“"]([^”"]+)[”"]/g)].map((match) =>
    match[1].trim(),
  );
  if (quoted.length > 0) {
    return quoted;
  }
  return text
    .split(/[、,，/；;\n]+/)
    .map((item) => item.replace(/组件$/u, "").trim())
    .filter(Boolean);
}

function chineseTitleName(originalName) {
  return CHINESE_TITLE_NAMES.get(originalName) ?? originalName;
}

function initialStatus(name, hValue) {
  if (DETAIL_NAMES.has(name) || name.includes("详情")) {
    return "skipped_detail";
  }
  if (normalizeCell(hValue) === "/") {
    return "skipped_h_unsupported";
  }
  return "pending";
}

export function buildCustomCodeHeadings(sequence, chineseName) {
  const serial = String(sequence).padStart(3, "0");
  return [...CUSTOM_CODE_LEVEL_NAMES].map(([level, suffix]) => ({
    level: `H${level}`,
    text: `组件代码测试-${serial}-${chineseName}-${suffix}`,
  }));
}

export function buildCustomCodeHtml(headings) {
  return headings
    .map(({ level, text }) => `<${level.toLowerCase()}>${text}</${level.toLowerCase()}>`)
    .join("\n");
}

export function buildRichTextDialogPlan(originalName, sequence) {
  const serial = String(sequence).padStart(3, "0");
  if (originalName === "图文页签") {
    return {
      expectedTitle: "",
      expectedTabTitle: `图文页签测试项-${serial}`,
      expectedEditors: [
        {
          key: "graphic_tab_content",
          text: `组件内容测试-${serial}-图文页签`,
          level: "H2",
          required_tokens: [],
        },
      ],
      requiredTokens: [],
      endDateStrategy: "",
    };
  }
  if (originalName === "公告") {
    return {
      expectedTitle: `组件标题测试-${serial}-公告`,
      expectedTabTitle: "",
      expectedEditors: [
        {
          key: "announcement_content",
          text: `组件内容测试-${serial}-公告`,
          level: "H2",
          required_tokens: [],
        },
      ],
      requiredTokens: [],
      endDateStrategy: "",
    };
  }
  if (originalName === "倒计时") {
    return {
      expectedTitle: "",
      expectedTabTitle: "",
      expectedEditors: [
        {
          key: "countdown_active",
          text: `组件内容测试-${serial}-倒计时-进行中`,
          level: "H2",
          required_tokens: ["{countdown}"],
        },
        {
          key: "countdown_finished",
          text: `组件内容测试-${serial}-倒计时-已结束`,
          level: "H2",
          required_tokens: [],
        },
      ],
      requiredTokens: ["{countdown}"],
      endDateStrategy: "today_plus_30_days",
    };
  }
  return {
    expectedTitle: "",
    expectedTabTitle: "",
    expectedEditors: [],
    requiredTokens: [],
    endDateStrategy: "",
  };
}

export async function readComponentWorkbook(workbookPath, sheetName = "一期清单") {
  const bytes = await readFile(workbookPath);
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const workbook = await SpreadsheetFile.importXlsx(bytes);
  const worksheet = workbook.worksheets.getItem(sheetName);
  if (!worksheet || worksheet.isNullObject) {
    throw new Error(`工作簿中未找到工作表：${sheetName}`);
  }

  const values = worksheet.getRange("A5:E41").values;
  const records = [];
  const duplicates = [];
  const seen = new Set();
  let targetSequence = 0;
  let inheritedEditor = "";
  let inheritedCategory = "";

  values.forEach((row, offset) => {
    const excelRow = offset + 5;
    const explicitEditor = normalizeCell(row[0]);
    const explicitCategory = normalizeCell(row[1]);
    if (explicitEditor) {
      inheritedEditor = explicitEditor;
    }
    if (explicitCategory) {
      inheritedCategory = explicitCategory;
    }
    const editor = inheritedEditor;
    const category = inheritedCategory;
    const sourceText = normalizeCell(row[2]);
    const hValue = normalizeCell(row[3]);
    const imageValue = normalizeCell(row[4]);
    if (editor !== "3.0编辑器" || category !== "组件" || !sourceText) {
      return;
    }
    for (const originalName of splitComponentNames(sourceText)) {
      if (seen.has(originalName)) {
        duplicates.push({ excel_row: excelRow, original_name: originalName });
        continue;
      }
      seen.add(originalName);
      const status = initialStatus(originalName, hValue);
      const translatedName = chineseTitleName(originalName);
      const sequence = status === "pending" ? ++targetSequence : null;
      const componentKind = CUSTOM_CODE_COMPONENTS.has(originalName)
        ? "custom_code"
        : RICH_TEXT_DIALOG_COMPONENTS.has(originalName)
          ? "rich_text_dialog"
          : "standard";
      const richTextPlan =
        sequence && componentKind === "rich_text_dialog"
          ? buildRichTextDialogPlan(originalName, sequence)
          : buildRichTextDialogPlan("", sequence);
      const expectedHeadings =
        sequence && componentKind === "custom_code"
          ? buildCustomCodeHeadings(sequence, translatedName)
          : [];
      const expectedCode = buildCustomCodeHtml(expectedHeadings);
      const expectedTitle =
        sequence && componentKind === "standard"
          ? `组件标题测试-${String(sequence).padStart(3, "0")}-${translatedName}`
          : richTextPlan.expectedTitle;
      if (
        (expectedTitle && /[A-Za-z]/.test(expectedTitle)) ||
        expectedHeadings.some(({ text }) => /[A-Za-z]/.test(text)) ||
        richTextPlan.expectedEditors.some(({ text }) => /[A-Za-z]/.test(text))
      ) {
        throw new Error(
          `组件 ${originalName} 的测试标题仍含英文字母`,
        );
      }
      records.push({
        excel_row: excelRow,
        editor,
        category,
        source_text: sourceText,
        original_name: originalName,
        chinese_name: translatedName,
        h_support: hValue,
        image_support: imageValue,
        sequence,
        component_kind: componentKind,
        expected_title: expectedTitle,
        expected_level: sequence && componentKind === "standard" ? "H2" : "",
        expected_code: expectedCode,
        expected_headings: expectedHeadings,
        expected_editors: richTextPlan.expectedEditors,
        expected_tab_title: richTextPlan.expectedTabTitle,
        expected_heading_count:
          componentKind === "rich_text_dialog"
            ? richTextPlan.expectedEditors.length
            : expectedHeadings.length,
        required_tokens: richTextPlan.requiredTokens,
        end_date_strategy: richTextPlan.endDateStrategy,
        initial_status: status,
      });
    }
  });

  const counts = records.reduce(
    (result, record) => {
      result[record.initial_status] =
        (result[record.initial_status] ?? 0) + 1;
      return result;
    },
    { unique: records.length, duplicates: duplicates.length },
  );
  return {
    checksum,
    workbookPath,
    sheetName,
    sourceRowCount: values.length,
    records,
    targetRecords: records.filter((record) => record.initial_status === "pending"),
    duplicates,
    counts,
  };
}

export {
  CHINESE_TITLE_NAMES,
  CUSTOM_CODE_COMPONENTS,
  DETAIL_NAMES,
  RICH_TEXT_DIALOG_COMPONENTS,
};
