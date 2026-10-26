#!/usr/bin/env node
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stdout } from "node:process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = path.join(root, "config", "v4-blocks.json");
const failures = [];
const warnings = [];

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) failures.push(`Node.js版本为${process.versions.node}，要求20或更高`);

let config = null;
try {
  config = JSON.parse(await readFile(configPath, "utf8"));
} catch (error) {
  failures.push(`配置读取失败：${error.message}`);
}

if (config) {
  for (const key of ["v4Csv", "v4EntryUrl", "siteName", "v4Categories", "v4PageDescriptors", "paths"]) {
    if (!config[key]) failures.push(`配置缺少${key}`);
  }
  const csvPath = path.resolve(root, config.v4Csv || "");
  try {
    const info = await stat(csvPath);
    if (!info.isFile() || info.size === 0) failures.push(`区块CSV无效：${csvPath}`);
  } catch {
    failures.push(`未找到区块CSV：${csvPath}`);
  }
  if (config.proxyServer && !String(config.v4EntryUrl).includes("jianzhan.leadong.com")) {
    warnings.push("已配置代理，但入口不是jianzhan.leadong.com，请确认环境没有混用");
  }
  if (!config.proxyServer && String(config.v4EntryUrl).includes("jianzhan.leadong.com")) {
    warnings.push("未配置代理，但入口为jianzhan.leadong.com，请确认网络可访问");
  }
  if (String(config.publicBaseUrl).includes("replace-with")) {
    warnings.push("publicBaseUrl仍是占位值；不影响编辑器铺页和H2数据设置，只会影响报告中的公开网址");
  }
  const authPath = path.resolve(root, config.paths?.userDataDir || ".auth/missing");
  try {
    await access(authPath);
  } catch {
    warnings.push("尚无本机登录状态，首次运行前请执行 npm run v4:block:auth");
  }
}

try {
  await import("playwright");
} catch {
  failures.push("未安装Playwright依赖，请先执行 npm install");
}

if (process.platform === "darwin") {
  try {
    await access("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  } catch {
    warnings.push("未在标准位置找到Google Chrome；请先安装Chrome或修改browser.channel配置");
  }
}

stdout.write(`\n环境检查\n- Node.js：${process.versions.node}\n- 配置：${configPath}\n- 模式：${config?.packageMode ?? "未知"}\n- 入口：${config?.v4EntryUrl ?? "未知"}\n- 站点：${config?.siteName ?? "未知"}\n- 代理：${config?.proxyServer || "不使用"}\n`);
for (const warning of warnings) stdout.write(`- 提醒：${warning}\n`);
for (const failure of failures) stdout.write(`- 错误：${failure}\n`);

if (failures.length > 0) {
  process.exitCode = 1;
} else {
  stdout.write("\n检查通过。下一步可执行 npm run v4:block:auth 或 npm run v4:block:plan。\n");
}
