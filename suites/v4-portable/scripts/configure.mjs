#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config", "v4-blocks.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const terminal = createInterface({ input: stdin, output: stdout });

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2).replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
    result[key] = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : true;
  }
  return result;
}

async function ask(message, fallback = "") {
  const suffix = fallback ? `（默认：${fallback}）` : "";
  const value = (await terminal.question(`${message}${suffix}：`)).trim();
  return value || fallback;
}

try {
  const args = parseArgs(process.argv.slice(2));
  stdout.write("\n4.0区块自动化环境配置\n\n1. 不挂代理（www.leadong.com）\n2. 测试环境代理（jianzhan.leadong.com）\n\n");
  const selected = args.mode
    ? ({ proxy: "2", "no-proxy": "1" }[String(args.mode)] ?? String(args.mode))
    : await ask("请选择1或2", config.packageMode === "proxy" ? "2" : "1");
  if (!["1", "2"].includes(selected)) throw new Error("只能输入1或2");
  const proxyMode = selected === "2";
  const suffix = proxyMode ? "proxy" : "no-proxy";

  config.packageMode = suffix;
  config.v4EntryUrl = proxyMode
    ? "https://admin.example.invalid/website.html"
    : "https://www.leadong.com/website.html";
  config.proxyServer = proxyMode
    ? String(args.proxy || await ask("代理地址", "http://proxy.example.invalid:8080"))
    : "";
  config.siteName = String(args.siteName || await ask("“我的网站”中的4.0站点名称", config.siteName || "4.0编辑器"));
  config.siteLanguage = String(args.language || await ask("站点语言", config.siteLanguage || "英语"));
  config.publicBaseUrl = String(
    args.publicBaseUrl || await ask(
      "站点公开域名（只用于报告，可暂时保留默认值）",
      config.publicBaseUrl || "http://replace-with-your-public-site.example",
    ),
  );

  config.paths = {
    userDataDir: `.auth/chrome-profile-v4-${suffix}`,
    v4StateFile: `.state/v4-block-run-state-${suffix}.json`,
    v4ArtifactsDir: `artifacts/v4-blocks-${suffix}`,
    v4ReportsDir: `reports/v4-blocks-${suffix}`,
  };
  config.v4RichText = {
    stateFile: `.state/v4-rich-text-first-page-${suffix}.json`,
    artifactsDir: `artifacts/v4-rich-text-first-page-${suffix}`,
    reportsDir: `reports/v4-rich-text-first-page-${suffix}`,
  };
  config.v4RichTextBatch = {
    stateFile: `.state/v4-rich-text-batch-${suffix}.json`,
    artifactsDir: `artifacts/v4-rich-text-batch-${suffix}`,
    reportsDir: `reports/v4-rich-text-batch-${suffix}`,
  };

  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  stdout.write(`\n配置已保存：${configPath}\n运行模式：${proxyMode ? "测试环境代理" : "不挂代理"}\n站点：${config.siteName}\n下一步：npm run check\n`);
} finally {
  terminal.close();
}
