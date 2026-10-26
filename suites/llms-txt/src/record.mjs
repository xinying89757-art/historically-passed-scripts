import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { loadConfig, resolveFromRoot, resolveRoot } from "./config.mjs";

const args = process.argv.slice(2);
const config = await loadConfig(findOption("--config") ?? undefined);
const startUrl = findOption("--start-url") ?? config.recordStartUrl ?? config.loginUrl;
const output = resolveFromRoot(findOption("--output") ?? "artifacts/codegen/recorded.spec.mjs");
await mkdir(path.dirname(output), { recursive: true });

const cliPath = path.join(resolveRoot(), "node_modules", "playwright", "cli.js");
const cliArgs = [
  cliPath,
  "codegen",
  "--target", "playwright-test",
  "--proxy-server", config.proxy.server,
  "--user-data-dir", config.paths.userDataDir,
  "--lang", config.browser.locale,
  "--viewport-size", `${config.browser.viewport.width},${config.browser.viewport.height}`,
  "--output", output,
  startUrl
];
if (config.browser.channel) cliArgs.splice(4, 0, "--channel", config.browser.channel);

console.log(`通过代理启动 Playwright codegen：${config.proxy.server}`);
console.log(`录制输出：${output}`);
console.log("请不要录制账号密码，也不要点击保存、发布或提交。");

const child = spawn(process.execPath, cliArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

function findOption(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
