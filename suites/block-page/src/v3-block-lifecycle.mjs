#!/usr/bin/env node
/**
 * 3.0 普通区块完整操作流程（Playwright）
 *
 * 执行：
 *   node src/v3-block-lifecycle.mjs
 *   node src/v3-block-lifecycle.mjs --config config/local.json
 *
 * 自动化：人工登录、区块清单读取、POC 添加、剩余区块添加与保存、打开目标页、
 * 保存人工编辑、打开预览、可选全站发布以及公开页区块 ID 校验。
 *
 * 通用文字/图片/链接/区块配置依赖各区块自己的编辑界面，脚本无法用一个稳定
 * 字段映射覆盖所有模板。因此脚本把当前 3.0 页面交给操作人员编辑，再由 Playwright
 * 保存、打开预览；可查看每一阶段代码以及 LeadongEditor 的定位实现。
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadConfig } from "./config.mjs";
import { readBlockCsv } from "./csv.mjs";
import {
  LeadongEditor,
  launchEditorBrowser,
} from "./editor.mjs";
import { provisionBlocks, publishAndVerify, summarizeState } from "./runner.mjs";
import { StateStore } from "./state.mjs";

function parseArgs(argv) {
  const options = { config: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      options.config = argv[index + 1] ?? "";
      if (!options.config || options.config.startsWith("--")) {
        throw new Error("--config 后必须提供 JSON 配置文件路径");
      }
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      stdout.write(
        "用法：node src/v3-block-lifecycle.mjs [--config config/local.json]\n",
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

function createPrompts() {
  const readline = createInterface({ input: stdin, output: stdout });
  return {
    async confirm(question) {
      while (true) {
        const answer = (await readline.question(`${question} [y/N] `))
          .trim()
          .toLowerCase();
        if (["y", "yes"].includes(answer)) return true;
        if (["", "n", "no"].includes(answer)) return false;
        stdout.write("请输入 y 或 n。\n");
      }
    },
    async enter(message) {
      await readline.question(`${message}\n按 Enter 继续。`);
    },
    async text(message) {
      return (await readline.question(message)).trim();
    },
    close() {
      readline.close();
    },
  };
}

async function login(config, prompts) {
  const { context, page } = await launchEditorBrowser(config, {
    headless: false,
    slowMo: 0,
  });
  try {
    await page.goto(config.editorUrl, { waitUntil: "domcontentloaded" });
    stdout.write("\n=== 登录 ===\n");
    stdout.write(
      "请在打开的 Chrome 中完成管理员登录；如遇验证码或二次验证，请按页面提示处理。\n",
    );
    await prompts.enter("登录完成后返回终端");

    const editor = new LeadongEditor(page, config);
    await editor.goto();
    stdout.write(
      `已确认进入目标 3.0 编辑器：${config.siteName} / ${config.siteLanguage}\n`,
    );
  } finally {
    await context.close();
  }
}

async function addBlocks(config, input, store, prompts) {
  stdout.write("\n=== POC：最多保存一页区块 ===\n");
  const poc = await provisionBlocks({
    config,
    input,
    store,
    maxPages: 1,
    headless: false,
  });
  stdout.write(`${JSON.stringify(summarizeState(poc.state), null, 2)}\n`);

  if (
    !(await prompts.confirm(
      "请检查 POC 页面、区块顺序和渲染结果；检查通过并继续添加剩余区块吗？",
    ))
  ) {
    stdout.write("已在 POC 检查点停止，运行状态已保存。\n");
    return false;
  }

  stdout.write("\n=== 添加剩余区块 ===\n");
  const result = await provisionBlocks({
    config,
    input,
    store,
    headless: false,
  });
  stdout.write(`${JSON.stringify(summarizeState(result.state), null, 2)}\n`);
  return true;
}

async function editAndPreview(config, state, prompts) {
  if (state.pages.length === 0) {
    throw new Error("运行状态中没有已保存页面，不能进入编辑和预览阶段");
  }

  const { context, page } = await launchEditorBrowser(config, {
    headless: false,
    slowMo: 0,
  });
  const editor = new LeadongEditor(page, config);
  try {
    await editor.goto();

    for (const [index, pageState] of state.pages.entries()) {
      stdout.write(
        `\n=== 编辑与预览 ${index + 1}/${state.pages.length}：${pageState.name} ===\n`,
      );
      await editor.openCustomPage(pageState.name);
      stdout.write(
        "请在当前 Chrome 编辑器中选择需要修改的区块，编辑文字、图片、链接或其他设置。\n" +
          "如设置面板有单独保存按钮，请先保存设置；无须编辑时可直接继续。\n",
      );
      await prompts.enter("完成当前页面编辑后返回终端");

      const saveResult = await editor.savePage();
      stdout.write(`编辑器页面已保存：${JSON.stringify(saveResult)}\n`);

      const preview = await editor.openPreviewPage(pageState.path);
      stdout.write(`预览已打开：${preview.url}\n`);
      stdout.write(
        "请在 Chrome 预览页检查页面路径、区块顺序、编辑内容、样式和交互。\n",
      );
      await prompts.enter("完成预览检查后返回终端");
      await preview.page.close().catch(() => {});
    }
  } finally {
    await context.close();
  }
}

async function maybePublish(config, input, store, prompts) {
  stdout.write("\n=== 可选：发布全站 ===\n");
  stdout.write(
    "发布操作会作用于整个站点，不只发布本次添加的页面。若其他已保存改动不应上线，请选择不发布。\n",
  );
  if (!(await prompts.confirm("现在发布并验证公开页吗？"))) {
    stdout.write("已跳过发布；区块仍保存在后台编辑器中。\n");
    return;
  }

  const host = await prompts.text(
    `请输入本次发布站点的 siteConfirmationHost（${config.siteConfirmationHost}）：`,
  );
  if (host !== config.siteConfirmationHost) {
    throw new Error(
      `发布已取消：输入主机名与配置不一致，预期 ${config.siteConfirmationHost}`,
    );
  }
  if (!(await prompts.confirm(`再次确认发布整个站点 ${host}？`))) {
    stdout.write("已取消发布。\n");
    return;
  }

  const result = await publishAndVerify({
    config,
    input,
    store,
    confirmSite: host,
    headless: false,
  });
  stdout.write("发布和公开页区块 ID 校验完成。\n");
  stdout.write(`${JSON.stringify(summarizeState(result.state), null, 2)}\n`);
  stdout.write(`运行追踪：${result.tracePath}\n`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const prompts = createPrompts();
  try {
    const config = await loadConfig(options.config || undefined);
    const input = await readBlockCsv(config.inputCsv);
    const store = new StateStore(config.paths.stateFile);

    stdout.write("=== 3.0 普通区块生命周期（Playwright）===\n");
    stdout.write(`站点：${config.siteName}\n语言：${config.siteLanguage}\n`);
    stdout.write(`区块清单：${config.inputCsv}\n`);
    stdout.write(`区块数：${input.blocks.length}\n每页上限：${config.blocksPerPage}\n`);
    stdout.write(
      "登录态和断点状态保存在当前电脑的 .auth/ 与 .state/ 目录。\n",
    );

    if (input.blocks.length === 0) {
      throw new Error("输入清单中没有可处理的区块");
    }
    if (
      !(await prompts.confirm(
        "请确认配置中的站点、语言、输入清单及页面前缀正确，开始执行吗？",
      ))
    ) {
      stdout.write("已取消；未登录或修改网站。\n");
      return;
    }

    await login(config, prompts);
    const added = await addBlocks(config, input, store, prompts);
    if (!added) return;

    const state = await store.load();
    if (!state) throw new Error("未找到区块添加状态文件");
    await editAndPreview(config, state, prompts);
    await maybePublish(config, input, store, prompts);
  } finally {
    prompts.close();
  }
}

main().catch((error) => {
  process.stderr.write(`\n生命周期脚本失败：${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
