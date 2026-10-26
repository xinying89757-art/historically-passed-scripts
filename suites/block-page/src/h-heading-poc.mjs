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

async function inspectFrame(frame, rootFingerprint) {
  const root = frame.locator(rootFingerprint).first();
  if (!(await root.isVisible().catch(() => false))) {
    return null;
  }

  await root.scrollIntoViewIfNeeded();
  await root.hover({ force: true });
  await frame.page().waitForTimeout(600);

  return frame.evaluate((fingerprint) => {
    const rootElement = document.querySelector(fingerprint);
    if (!rootElement) {
      return null;
    }

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
    const summarize = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        tag: element.tagName.toLowerCase(),
        id: element.id || "",
        className:
          typeof element.className === "string" ? element.className : "",
        text: (element.innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160),
        title: element.getAttribute("title") || "",
        ariaLabel: element.getAttribute("aria-label") || "",
        role: element.getAttribute("role") || "",
        href: element.getAttribute("href") || "",
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
    };

    const headingElements = [...rootElement.querySelectorAll("h1,h2,h3,h4,h5,h6")]
      .filter(visible)
      .map((element, index) => ({
        index,
        level: element.tagName.toLowerCase(),
        text: (element.innerText || element.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
        className:
          typeof element.className === "string" ? element.className : "",
      }));
    const editableContents = [
      ...rootElement.querySelectorAll(
        "[contenteditable='true'], [role='textbox'].cke_editable, .cke_editable_inline",
      ),
    ].map((element) => ({
      id: element.id || "",
      text: (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim(),
      html: element.innerHTML.slice(0, 1200),
    }));

    const candidateSelector = [
      "a",
      "button",
      "input",
      "select",
      "textarea",
      "[role='button']",
      "[title]",
      "[aria-label]",
      "[data-title]",
    ].join(",");
    const scopes = [];
    let current = rootElement;
    for (let depth = 0; depth < 4 && current; depth += 1) {
      scopes.push(current);
      current = current.parentElement;
    }
    const candidates = new Set();
    for (const scope of scopes) {
      if (scope.matches(candidateSelector)) {
        candidates.add(scope);
      }
      for (const element of scope.querySelectorAll(candidateSelector)) {
        candidates.add(element);
      }
    }

    const interactiveElements = [...candidates]
      .filter(visible)
      .map(summarize)
      .filter((item) => {
        const searchable = [
          item.text,
          item.title,
          item.ariaLabel,
          item.className,
          item.id,
          item.href,
        ]
          .join(" ")
          .toLowerCase();
        return /设置|编辑|setting|edit|module|block|app/.test(searchable);
      })
      .slice(0, 120);

    return {
      root: summarize(rootElement),
      headings: headingElements,
      editableContents,
      interactiveElements,
    };
  }, rootFingerprint);
}

async function activateInlineHeading(
  editor,
  audit,
  editableIndex = 0,
  { selectAll = false } = {},
) {
  for (const frame of editor.canvasContexts()) {
    if (frame.url() !== audit.frame_url) {
      continue;
    }
    const root = frame.locator(audit.fingerprint).first();
    if (!(await root.isVisible().catch(() => false))) {
      continue;
    }
    const editable = root
      .locator(
        "[contenteditable='true'], [role='textbox'].cke_editable, .cke_editable_inline",
      )
      .nth(editableIndex);
    if (!(await editable.isVisible().catch(() => false))) {
      return { activated: false, reason: "区块内没有可见的内嵌富文本编辑区" };
    }
    await editable.click();
    if (selectAll) {
      await editable.selectText();
    }
    await editor.page.waitForTimeout(800);
    return {
      activated: true,
      frameUrl: frame.url(),
      editableId: await editable.getAttribute("id"),
      editableText: (await editable.innerText()).replace(/\s+/g, " ").trim(),
      editableTag: await editable.evaluate((element) =>
        element.tagName.toLowerCase(),
      ),
    };
  }
  return { activated: false, reason: "没有找到目标区块所在画布" };
}

async function fillActivatedEditable(editor, activation, text) {
  for (const frame of editor.canvasContexts()) {
    if (frame.url() !== activation.frameUrl) {
      continue;
    }
    const editable = frame
      .locator(`[id="${activation.editableId}"]`)
      .first();
    if (!(await editable.isVisible().catch(() => false))) {
      break;
    }
    await editable.fill(text);
    await editor.page.waitForTimeout(700);
    return;
  }
  throw new Error("无法重新定位已激活的标题编辑区");
}

async function openInlineFormatMenu(editor, activation) {
  if (!activation.activated || !activation.editableId) {
    return { opened: false, reason: "内嵌富文本未激活" };
  }
  for (const frame of editor.canvasContexts()) {
    if (frame.url() !== activation.frameUrl) {
      continue;
    }
    const editorShell = frame
      .locator(`[id="cke_${activation.editableId}"]`)
      .first();
    const formatButton = editorShell
      .locator(".cke_combo__format .cke_combo_button")
      .first();
    if (!(await formatButton.isVisible().catch(() => false))) {
      return { opened: false, reason: "未找到当前标题对应的“格式”按钮" };
    }
    await formatButton.click();
    await editor.page.waitForTimeout(700);
    const optionFrames = [];
    for (const candidate of editor.contexts()) {
      const optionTexts = await candidate
        .locator("body")
        .innerText()
        .catch(() => "");
      if (/标题\s*[1-6]|Heading\s*[1-6]|H[1-6]/i.test(optionTexts)) {
        optionFrames.push({
          frameUrl: candidate.url(),
          text: optionTexts.replace(/\s+/g, " ").trim().slice(0, 500),
        });
      }
    }
    return {
      opened: optionFrames.length > 0,
      formatButtonText: (await formatButton.innerText())
        .replace(/\s+/g, " ")
        .trim(),
      optionFrames,
      reason:
        optionFrames.length > 0
          ? ""
          : "点击“格式”后没有发现H1～H6选项文字",
    };
  }
  return { opened: false, reason: "没有找到激活标题所在画布" };
}

async function chooseFormatOption(editor, optionLabel) {
  const matches = [];
  for (const scope of editor.contexts()) {
    const option = scope
      .locator(`[role="option"][title="${optionLabel}"]`)
      .first();
    if ((await option.count().catch(() => 0)) > 0) {
      matches.push(option);
    }
  }
  if (matches.length !== 1) {
    throw new Error(
      `格式菜单中“${optionLabel}”选项数量为 ${matches.length}，拒绝随机点击`,
    );
  }
  await matches[0].click({ force: true });
  await editor.page.waitForTimeout(900);
}

async function focusHeadingNode(heading) {
  await heading.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    const editable = element.closest("[contenteditable='true']");
    editable?.focus();
    const selection = element.ownerDocument.getSelection();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(
      new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
        view: element.ownerDocument.defaultView,
      }),
    );
  });
}

async function convertRemainingHeadings(
  editor,
  audit,
  activation,
  optionLabel,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let heading = null;
    for (const frame of editor.canvasContexts()) {
      if (frame.url() !== audit.frame_url) {
        continue;
      }
      const candidate = frame
        .locator(`[id="${activation.editableId}"]`)
        .first()
        .locator("h1,h2,h3,h4,h5,h6")
        .first();
      if ((await candidate.count().catch(() => 0)) > 0) {
        heading = candidate;
        break;
      }
    }
    if (!heading) {
      return;
    }
    await focusHeadingNode(heading);
    await editor.page.waitForTimeout(400);
    const menu = await openInlineFormatMenu(editor, activation);
    if (!menu.opened) {
      throw new Error("清理残留H节点时无法打开格式菜单");
    }
    await chooseFormatOption(editor, optionLabel);
  }
  throw new Error("连续处理12次后仍有残留H节点");
}

async function convertEmptyHeadings(
  editor,
  audit,
  activation,
  optionLabel,
) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let emptyHeading = null;
    for (const frame of editor.canvasContexts()) {
      if (frame.url() !== audit.frame_url) {
        continue;
      }
      const headings = frame
        .locator(`[id="${activation.editableId}"]`)
        .first()
        .locator("h1,h2,h3,h4,h5,h6");
      const count = await headings.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        const candidate = headings.nth(index);
        const text = (await candidate.innerText().catch(() => ""))
          .replace(/\s+/g, " ")
          .trim();
        if (!text) {
          emptyHeading = candidate;
          break;
        }
      }
      if (emptyHeading) {
        break;
      }
    }
    if (!emptyHeading) {
      return;
    }
    await focusHeadingNode(emptyHeading);
    await editor.page.waitForTimeout(400);
    const menu = await openInlineFormatMenu(editor, activation);
    if (!menu.opened) {
      throw new Error("清理空H节点时无法打开格式菜单");
    }
    await chooseFormatOption(editor, optionLabel);
  }
  throw new Error("连续处理12次后仍有空H节点");
}

function headingCountsEqual(left, right) {
  return ["h1", "h2", "h3", "h4", "h5", "h6"].every(
    (level) => left?.[level] === right?.[level],
  );
}

async function inspectHeadingMarkup(editor, audit, expectedText) {
  for (const frame of editor.canvasContexts()) {
    if (frame.url() !== audit.frame_url) {
      continue;
    }
    return frame
      .locator(audit.fingerprint)
      .first()
      .evaluate((root, text) => {
        const normalized = (value) => value.replace(/\s+/g, " ").trim();
        return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
          .filter(
            (element) =>
              normalized(element.innerText || element.textContent || "") ===
              text,
          )
          .map((element) => ({
            level: element.tagName.toLowerCase(),
            text: normalized(element.innerText || element.textContent || ""),
          }));
      }, expectedText);
  }
  return [];
}

async function inspectVisibleControls(editor) {
  const results = [];
  for (const scope of editor.contexts()) {
    const controls = await scope
      .evaluate(() => {
        const visible = (element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.left < window.innerWidth &&
            rect.bottom > 0 &&
            rect.top < window.innerHeight
          );
        };
        const selector = [
          "button",
          "a",
          "select",
          "input",
          "[role='button']",
          "[role='combobox']",
          "[title]",
          "[aria-label]",
          ".cke_toolbar",
          ".cke_combo",
        ].join(",");
        return [...document.querySelectorAll(selector)]
          .filter(visible)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              id: element.id || "",
              className:
                typeof element.className === "string" ? element.className : "",
              text: (element.innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 120),
              title: element.getAttribute("title") || "",
              ariaLabel: element.getAttribute("aria-label") || "",
              role: element.getAttribute("role") || "",
              rect: {
                x: Math.round(rect.x),
                y: Math.round(rect.y),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
            };
          })
          .filter((item) =>
            /标题|段落|格式|正文|heading|format|paragraph|h[1-6]|cke_|设置|编辑/i.test(
              [
                item.text,
                item.title,
                item.ariaLabel,
                item.className,
                item.id,
              ].join(" "),
            ),
          )
          .slice(0, 180);
      })
      .catch(() => []);
    results.push({
      frameUrl: scope.url(),
      controls,
    });
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pageName = options.page ?? "GE-区块测试-137";
  const blockId = String(options.blockId ?? "9104");
  const editableIndex = Number(options.editableIndex ?? 0);
  const config = await loadConfig(options.config);
  const { context, page } = await launchEditorBrowser(config, {
    headless: options.headless === true,
    slowMo: Number(options.slowMo ?? 250),
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

    const audit = audits[0];
    let inspection = null;
    for (const frame of editor.canvasContexts()) {
      if (frame.url() !== audit.frame_url) {
        continue;
      }
      inspection = await inspectFrame(frame, audit.fingerprint);
      if (inspection) {
        break;
      }
    }
    if (!inspection) {
      throw new Error(`无法在画布中重新定位 block_id=${blockId}`);
    }
    const shouldActivate =
      options.activate || options.openFormat || options.apply;
    const activation = shouldActivate
      ? await activateInlineHeading(editor, audit, editableIndex, {
          selectAll: Boolean(options.apply),
        })
      : { activated: false, reason: "未传 --activate" };
    const formatMenu = options.openFormat || options.apply
      ? await openInlineFormatMenu(editor, activation)
      : { opened: false, reason: "未传 --open-format" };
    const visibleControls = shouldActivate
      ? await inspectVisibleControls(editor)
      : [];

    const outputDir = path.join(config.paths.artifactsDir, "h-heading-poc");
    await mkdir(outputDir, { recursive: true });
    const runStamp = timestamp();
    const jsonPath = path.join(
      outputDir,
      `${runStamp}-${pageName}-${blockId}-probe.json`,
    );
    const screenshotPath = path.join(
      outputDir,
      `${runStamp}-${pageName}-${blockId}-probe.png`,
    );
    const result = {
      pageName,
      blockId,
      pageUrl: editor.page.url(),
      audit,
      inspection,
      activation,
      formatMenu,
      visibleControls,
      changed: false,
    };
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);

    if (options.apply && options.restoreOnly) {
      if (!activation.activated || !formatMenu.opened) {
        throw new Error("恢复时H标签设置控件未稳定定位");
      }
      const originalLabel = String(
        options.originalLabel ?? "段落(DIV)",
      );
      const originalText = String(
        options.originalText ?? activation.editableText,
      );
      await chooseFormatOption(editor, originalLabel);
      await fillActivatedEditable(editor, activation, originalText);
      if (originalLabel === "段落(DIV)") {
        await convertRemainingHeadings(
          editor,
          audit,
          activation,
          originalLabel,
        );
      }
      const beforeSave = await editor.auditBlock(blockId);
      const markupBeforeSave =
        beforeSave.length === 1
          ? await inspectHeadingMarkup(editor, beforeSave[0], originalText)
          : [];
      if (originalLabel === "段落(DIV)" && markupBeforeSave.length !== 0) {
        throw new Error("恢复为DIV并清理文字后，DOM中仍然存在目标H标签");
      }
      if (
        originalLabel === "段落(DIV)" &&
        beforeSave[0] &&
        Object.values(beforeSave[0].heading_counts).some(
          (count) => count !== 0,
        )
      ) {
        throw new Error("恢复为DIV后，区块中仍存在空H标签");
      }
      const save = await editor.savePage();
      await editor.openCustomPage(pageName);
      const reopened = await editor.auditBlock(blockId);
      const restoredMarkup =
        reopened.length === 1
          ? await inspectHeadingMarkup(editor, reopened[0], originalText)
          : [];
      if (originalLabel === "段落(DIV)" && restoredMarkup.length !== 0) {
        throw new Error("恢复保存并重新打开后，目标文字仍然是H标签");
      }
      if (
        originalLabel === "段落(DIV)" &&
        reopened[0] &&
        Object.values(reopened[0].heading_counts).some(
          (count) => count !== 0,
        )
      ) {
        throw new Error("恢复保存并重新打开后，区块中仍存在空H标签");
      }
      result.restored = true;
      result.restore = {
        originalLabel,
        originalText,
        save,
        markupBeforeSave,
        restoredMarkup,
      };
    } else if (options.apply) {
      const targetLevel = String(options.targetLevel ?? "h2").toLowerCase();
      if (!/^h[1-6]$/.test(targetLevel)) {
        throw new Error("--target-level 只能是 h1～h6");
      }
      if (!activation.activated || !formatMenu.opened) {
        throw new Error("H标签设置控件未稳定定位，拒绝执行修改");
      }
      const targetLabel = `标题 ${targetLevel.slice(1)}`;
      const originalLabel = formatMenu.formatButtonText;
      const originalText = activation.editableText;
      await chooseFormatOption(editor, targetLabel);
      await convertEmptyHeadings(
        editor,
        audit,
        activation,
        "段落(DIV)",
      );
      const afterChange = await editor.auditBlock(blockId);
      if (
        afterChange.length !== 1 ||
        afterChange[0].heading_counts[targetLevel] !==
          audit.heading_counts[targetLevel] + 1
      ) {
        throw new Error(
          `选择“${targetLabel}”后${targetLevel}数量不是基线+1`,
        );
      }
      const changedMarkup = await inspectHeadingMarkup(
        editor,
        afterChange[0],
        originalText,
      );
      if (!changedMarkup.some((item) => item.level === targetLevel)) {
        throw new Error(`目标文字没有被转换为${targetLevel}`);
      }
      const firstSave = await editor.savePage();
      await editor.openCustomPage(pageName);
      const reopenedAfterChange = await editor.auditBlock(blockId);
      const persistedMarkup =
        reopenedAfterChange.length === 1
          ? await inspectHeadingMarkup(
              editor,
              reopenedAfterChange[0],
              originalText,
            )
          : [];
      if (!persistedMarkup.some((item) => item.level === targetLevel)) {
        throw new Error(`保存并重新打开后，目标文字没有保持为${targetLevel}`);
      }
      result.changed = true;
      result.change = {
        originalLabel,
        targetLevel,
        targetLabel,
        originalText,
        firstSave,
        changedMarkup,
        persistedMarkup,
      };

      const holdAfterChangeMs = Number(options.holdAfterChangeMs ?? 0);
      if (Number.isFinite(holdAfterChangeMs) && holdAfterChangeMs > 0) {
        const reopenedAudit = reopenedAfterChange[0];
        if (reopenedAudit) {
          for (const frame of editor.canvasContexts()) {
            if (frame.url() === reopenedAudit.frame_url) {
              const root = frame.locator(reopenedAudit.fingerprint).first();
              await root.scrollIntoViewIfNeeded().catch(() => {});
              break;
            }
          }
        }
        await editor.page.waitForTimeout(holdAfterChangeMs);
      }

      if (options.restore) {
        const restoreAudit = (await editor.auditBlock(blockId))[0];
        const restoreActivation = await activateInlineHeading(
          editor,
          restoreAudit,
          editableIndex,
          { selectAll: true },
        );
        const restoreMenu = await openInlineFormatMenu(
          editor,
          restoreActivation,
        );
        if (!restoreMenu.opened) {
          throw new Error("修改成功，但恢复时无法重新打开格式菜单");
        }
        await chooseFormatOption(editor, originalLabel);
        if (originalLabel === "段落(DIV)") {
          await convertRemainingHeadings(
            editor,
            restoreAudit,
            restoreActivation,
            originalLabel,
          );
        }
        const beforeRestoreSave = await editor.auditBlock(blockId);
        if (
          beforeRestoreSave.length !== 1 ||
          !headingCountsEqual(
            beforeRestoreSave[0].heading_counts,
            audit.heading_counts,
          )
        ) {
          throw new Error("恢复后、保存前的H1～H6数量没有回到基线");
        }
        const secondSave = await editor.savePage();
        await editor.openCustomPage(pageName);
        const reopenedAfterRestore = await editor.auditBlock(blockId);
        const restoredMarkup =
          reopenedAfterRestore.length === 1
            ? await inspectHeadingMarkup(
                editor,
                reopenedAfterRestore[0],
                originalText,
              )
            : [];
        if (originalLabel === "段落(DIV)" && restoredMarkup.length !== 0) {
          throw new Error("恢复并重新打开后，目标文字仍然是H标签");
        }
        if (
          reopenedAfterRestore.length !== 1 ||
          !headingCountsEqual(
            reopenedAfterRestore[0].heading_counts,
            audit.heading_counts,
          )
        ) {
          throw new Error("恢复并重新打开后，H1～H6数量没有回到基线");
        }
        result.restored = true;
        result.restore = {
          originalLabel,
          secondSave,
          restoredMarkup,
        };
      }
    }
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    if (!options.skipScreenshot) {
      await editor.page.screenshot({
        path: screenshotPath,
        fullPage: true,
      });
    }
    const holdMs = Number(options.holdMs ?? 0);
    if (Number.isFinite(holdMs) && holdMs > 0) {
      await editor.page.waitForTimeout(holdMs);
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
