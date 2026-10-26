#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import {
  LeadongEditor,
  launchEditorBrowser,
} from "./editor.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token
      .slice(2)
      .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index += 1;
    } else {
      options[key] = true;
    }
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function openBlockSettings(editor, audit) {
  const matchingFrames = editor
    .canvasContexts()
    .filter((frame) => frame.url() === audit.frame_url);
  if (matchingFrames.length !== 1) {
    throw new Error(`目标区块所在画布数量为 ${matchingFrames.length}`);
  }
  const frame = matchingFrames[0];
  const root = frame.locator(audit.fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  await root.hover({ force: true });
  await editor.page.waitForTimeout(600);

  const buttonIds = await root.evaluate((rootElement) => {
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const candidates = new Set();
    let current = rootElement;
    for (let depth = 0; depth < 5 && current; depth += 1) {
      for (const element of current.querySelectorAll("a,button,[role='button']")) {
        candidates.add(element);
      }
      current = current.parentElement;
    }
    return [...candidates]
      .filter(visible)
      .filter(
        (element) =>
          (element.innerText || element.textContent || "")
            .replace(/\s+/g, " ")
            .trim() === "设置",
      )
      .map((element) => element.id || "")
      .filter(Boolean);
  });
  if (buttonIds.length !== 1) {
    throw new Error(
      `目标区块“设置”按钮数量为 ${buttonIds.length}，拒绝随机点击`,
    );
  }
  const settingsButton = frame.locator(`[id="${buttonIds[0]}"]`);
  if ((await settingsButton.count()) !== 1) {
    throw new Error("无法唯一重新定位目标区块“设置”按钮");
  }
  await settingsButton.click();
  await editor.page.waitForTimeout(1000);
  return { frameUrl: frame.url(), buttonId: buttonIds[0] };
}

async function findDescriptionEditor(editor) {
  const modal = editor.page.locator(".pics_gallery_new:visible");
  if ((await modal.count()) !== 1) {
    throw new Error(`“编辑图片集”弹窗数量为 ${await modal.count()}`);
  }

  const formatButton = modal.locator(
    ".cke_combo__format .cke_combo_button",
  );
  if ((await formatButton.count()) !== 1) {
    throw new Error(
      `描述富文本“格式”按钮数量为 ${await formatButton.count()}`,
    );
  }
  await formatButton.scrollIntoViewIfNeeded();

  const richTextCandidates = [];
  for (const frame of editor.page.frames()) {
    const body = frame.locator(
      "body.cke_editable[contenteditable='true'], body[contenteditable='true']",
    );
    const count = await body.count().catch(() => 0);
    if (count !== 1) {
      continue;
    }
    const text = (await body.innerText().catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    const html = await body.innerHTML().catch(() => "");
    richTextCandidates.push({ frame, body, text, html });
  }
  const candidatesWithText = richTextCandidates.filter((item) => item.text);
  if (candidatesWithText.length !== 1) {
    throw new Error(
      `弹窗中有文本的富文本编辑区数量为 ${candidatesWithText.length}`,
    );
  }

  return {
    modal,
    formatButton,
    ...candidatesWithText[0],
  };
}

async function chooseFormatOption(editor, targetLabel) {
  const matches = [];
  for (const frame of editor.page.frames()) {
    const option = frame.locator(
      `[role="option"][title="${targetLabel}"]`,
    );
    const count = await option.count().catch(() => 0);
    if (count !== 1) {
      continue;
    }
    if (await option.isVisible().catch(() => false)) {
      matches.push(option);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `格式菜单中可见的“${targetLabel}”数量为 ${matches.length}`,
    );
  }
  await matches[0].click({ force: true });
  await editor.page.waitForTimeout(800);
}

async function inspectBlockHeadings(editor, audit, text) {
  const matchingFrames = editor
    .canvasContexts()
    .filter((frame) => frame.url() === audit.frame_url);
  if (matchingFrames.length !== 1) {
    return [];
  }
  return matchingFrames[0]
    .locator(audit.fingerprint)
    .first()
    .evaluate((root, expectedText) => {
      const normalized = (value) => value.replace(/\s+/g, " ").trim();
      return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
        .filter((element) =>
          normalized(element.innerText || element.textContent || "").includes(
            expectedText,
          ),
        )
        .map((element) => ({
          level: element.tagName.toLowerCase(),
          text: normalized(element.innerText || element.textContent || ""),
        }));
    }, text);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pageName = options.page ?? "GE-区块测试-047";
  const blockId = String(options.blockId ?? "14674");
  const targetLevel = String(options.targetLevel ?? "h4").toLowerCase();
  if (!/^h[1-6]$/.test(targetLevel)) {
    throw new Error("--target-level 只能是 h1～h6");
  }

  const config = await loadConfig(options.config);
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: Number(options.slowMo ?? 500),
  });

  try {
    const editor = new LeadongEditor(page, config);
    await editor.goto();
    await editor.openCustomPage(pageName);
    const audits = await editor.auditBlock(blockId);
    if (audits.length !== 1) {
      throw new Error(
        `${pageName} 中 block_id=${blockId} 的区块根节点数量为 ${audits.length}`,
      );
    }
    const baseline = audits[0];
    const settings = await openBlockSettings(editor, baseline);
    const description = await findDescriptionEditor(editor);
    const originalText = description.text;
    const originalHtml = description.html;
    await description.body.click();
    await description.body.selectText();
    await description.formatButton.click();
    await page.waitForTimeout(600);
    const targetLabel = `标题 ${targetLevel.slice(1)}`;
    await chooseFormatOption(editor, targetLabel);

    const changedHtml = await description.body.innerHTML();
    const changedHeadingCount = await description.body
      .locator(targetLevel)
      .count();
    if (
      changedHeadingCount < 1 ||
      !(await description.body
        .locator(targetLevel)
        .innerText()
        .catch(() => ""))
        .replace(/\s+/g, " ")
        .trim()
        .includes(originalText)
    ) {
      throw new Error(`描述全文没有被转换为 ${targetLevel}`);
    }

    const modalSave = description.modal.locator(
      "a.btn_galleryconfirm:visible",
    );
    if ((await modalSave.count()) !== 1) {
      throw new Error(`图片集弹窗“保存”按钮数量为 ${await modalSave.count()}`);
    }
    await modalSave.click();
    await description.modal.waitFor({ state: "hidden", timeout: 15000 });
    await page.waitForTimeout(1000);

    const afterDialogAudits = await editor.auditBlock(blockId);
    if (afterDialogAudits.length !== 1) {
      throw new Error("弹窗保存后无法唯一定位目标区块");
    }
    const afterDialogHeadings = await inspectBlockHeadings(
      editor,
      afterDialogAudits[0],
      originalText,
    );
    if (!afterDialogHeadings.some((item) => item.level === targetLevel)) {
      throw new Error("弹窗保存后，画布中未出现目标 H 标签");
    }

    const pageSave = await editor.savePage();
    await editor.openCustomPage(pageName);
    const reopenedAudits = await editor.auditBlock(blockId);
    if (reopenedAudits.length !== 1) {
      throw new Error("页面重新打开后无法唯一定位目标区块");
    }
    const persistedHeadings = await inspectBlockHeadings(
      editor,
      reopenedAudits[0],
      originalText,
    );
    if (!persistedHeadings.some((item) => item.level === targetLevel)) {
      throw new Error("页面保存并重新打开后，描述没有保持目标 H 标签");
    }

    const outputDir = path.join(
      config.paths.artifactsDir,
      "h-gallery-description-poc",
    );
    await mkdir(outputDir, { recursive: true });
    const runStamp = timestamp();
    const jsonPath = path.join(
      outputDir,
      `${runStamp}-${pageName}-${blockId}-${targetLevel}.json`,
    );
    const screenshotPath = path.join(
      outputDir,
      `${runStamp}-${pageName}-${blockId}-${targetLevel}.png`,
    );
    const result = {
      ok: true,
      pageName,
      blockId,
      targetLevel,
      settings,
      originalText,
      originalHtml,
      changedHtml,
      afterDialogHeadings,
      pageSave,
      persistedHeadings,
      restored: false,
    };
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const holdMs = Number(options.holdAfterChangeMs ?? 0);
    if (Number.isFinite(holdMs) && holdMs > 0) {
      const reopened = reopenedAudits[0];
      const matchingFrame = editor
        .canvasContexts()
        .find((frame) => frame.url() === reopened.frame_url);
      await matchingFrame
        ?.locator(reopened.fingerprint)
        .first()
        .scrollIntoViewIfNeeded()
        .catch(() => {});
      await page.waitForTimeout(holdMs);
    }
    process.stdout.write(
      `${JSON.stringify({ ok: true, jsonPath, screenshotPath, result }, null, 2)}\n`,
    );
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
