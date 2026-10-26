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

async function findSettingsButton(frame, fingerprint) {
  const root = frame.locator(fingerprint).first();
  await root.scrollIntoViewIfNeeded();
  await root.hover({ force: true });
  await frame.page().waitForTimeout(600);

  return root.evaluate((rootElement) => {
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
      .map((element) => ({
        id: element.id || "",
        tag: element.tagName.toLowerCase(),
        className:
          typeof element.className === "string" ? element.className : "",
      }));
  });
}

async function inspectSettingsUi(editor) {
  const results = [];
  for (const scope of editor.contexts()) {
    const inspection = await scope
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
        const summarize = (element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLowerCase(),
            id: element.id || "",
            className:
              typeof element.className === "string" ? element.className : "",
            type: element.getAttribute("type") || "",
            name: element.getAttribute("name") || "",
            value: element.getAttribute("value") || "",
            checked:
              element instanceof HTMLInputElement ? element.checked : null,
            text: (element.innerText || element.textContent || "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 180),
            title: element.getAttribute("title") || "",
            ariaLabel: element.getAttribute("aria-label") || "",
            placeholder: element.getAttribute("placeholder") || "",
            rect: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
          };
        };

        const controls = [
          ...document.querySelectorAll(
            "input,textarea,select,button,a,label,[role='radio'],[role='dialog']",
          ),
        ]
          .filter(visible)
          .map(summarize)
          .filter((item) =>
            /组件标题|标题类型|标题|h[1-6]|段落|保存|取消|确定|setting|edit/i.test(
              [
                item.text,
                item.title,
                item.ariaLabel,
                item.placeholder,
                item.name,
                item.value,
                item.className,
                item.id,
              ].join(" "),
            ),
          )
          .slice(0, 160);

        const submit = [...document.querySelectorAll("a,button")]
          .filter(visible)
          .find(
            (element) =>
              (element.innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim() === "保存" &&
              /dialog-submit/.test(
                typeof element.className === "string"
                  ? element.className
                  : "",
              ),
          );
        let dialog = submit;
        for (let depth = 0; depth < 8 && dialog?.parentElement; depth += 1) {
          const parent = dialog.parentElement;
          const rect = parent.getBoundingClientRect();
          const text = (parent.innerText || parent.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          dialog = parent;
          if (rect.width >= 500 && rect.height >= 350 && text.length >= 30) {
            break;
          }
        }
        const dialogControls = dialog
          ? [
              ...dialog.querySelectorAll(
                "input,textarea,select,button,a,label,[role='radio']",
              ),
            ]
              .filter((element) => {
                const style = getComputedStyle(element);
                return (
                  style.display !== "none" &&
                  style.visibility !== "hidden"
                );
              })
              .map((element) => ({
                ...summarize(element),
                nearbyText: (
                  element.parentElement?.innerText ||
                  element.parentElement?.textContent ||
                  ""
                )
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 260),
              }))
              .slice(0, 260)
          : [];
        const scrollAreas = dialog
          ? [...dialog.querySelectorAll("*")]
              .filter(
                (element) =>
                  element.scrollHeight > element.clientHeight + 20 &&
                  element.clientHeight > 100,
              )
              .map((element) => ({
                tag: element.tagName.toLowerCase(),
                id: element.id || "",
                className:
                  typeof element.className === "string"
                    ? element.className
                    : "",
                clientHeight: element.clientHeight,
                scrollHeight: element.scrollHeight,
              }))
              .slice(0, 20)
          : [];

        const marker = [...document.querySelectorAll("body *")]
          .filter(visible)
          .find((element) =>
            /标题类型|组件标题/.test(
              (element.innerText || element.textContent || "")
                .replace(/\s+/g, " ")
                .trim(),
            ),
          );
        let panel = marker;
        for (let depth = 0; depth < 5 && panel?.parentElement; depth += 1) {
          const text = (panel.innerText || panel.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          if (text.length >= 20 && text.length <= 2000) {
            break;
          }
          panel = panel.parentElement;
        }

        return {
          markerFound: Boolean(marker),
          panel: panel && visible(panel) ? summarize(panel) : null,
          controls,
          dialog: dialog
            ? {
                tag: dialog.tagName.toLowerCase(),
                id: dialog.id || "",
                className:
                  typeof dialog.className === "string"
                    ? dialog.className
                    : "",
                text: (dialog.innerText || dialog.textContent || "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 6000),
              }
            : null,
          dialogControls,
          scrollAreas,
        };
      })
      .catch(() => ({
        markerFound: false,
        panel: null,
        controls: [],
        dialog: null,
        dialogControls: [],
        scrollAreas: [],
      }));
    if (
      inspection.markerFound ||
      inspection.controls.length > 0 ||
      inspection.dialog
    ) {
      results.push({
        frameUrl: scope.url(),
        ...inspection,
      });
    }
  }
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const pageName = options.page ?? "GE-区块测试-026";
  const blockId = String(options.blockId ?? "5879");
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
    const matchingFrames = editor
      .canvasContexts()
      .filter((frame) => frame.url() === audit.frame_url);
    if (matchingFrames.length !== 1) {
      throw new Error(`目标区块所在画布数量为 ${matchingFrames.length}`);
    }

    const settingsButtons = await findSettingsButton(
      matchingFrames[0],
      audit.fingerprint,
    );
    if (settingsButtons.length !== 1 || !settingsButtons[0].id) {
      throw new Error(
        `目标区块“设置”按钮数量为 ${settingsButtons.length}，拒绝随机点击`,
      );
    }
    const settingsButton = matchingFrames[0].locator(
      `[id="${settingsButtons[0].id}"]`,
    );
    if ((await settingsButton.count()) !== 1) {
      throw new Error("无法唯一重新定位目标区块“设置”按钮");
    }
    await settingsButton.click();
    await page.waitForTimeout(1200);

    const settingsUi = await inspectSettingsUi(editor);
    const outputDir = path.join(config.paths.artifactsDir, "h-settings-poc");
    await mkdir(outputDir, { recursive: true });
    const runStamp = timestamp();
    const jsonPath = path.join(
      outputDir,
      `${runStamp}-${pageName}-${blockId}-settings.json`,
    );
    const screenshotPath = path.join(
      outputDir,
      `${runStamp}-${pageName}-${blockId}-settings.png`,
    );
    const result = {
      pageName,
      blockId,
      pageUrl: page.url(),
      audit,
      settingsButtons,
      settingsUi,
      changed: false,
    };
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    if (!options.skipScreenshot) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
    const holdMs = Number(options.holdMs ?? 0);
    if (Number.isFinite(holdMs) && holdMs > 0) {
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
