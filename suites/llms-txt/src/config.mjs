import { readFile } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

function merge(base, override) {
  if (!override || typeof override !== "object") return structuredClone(base);
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = merge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function resolveRoot() {
  return ROOT;
}

export function resolveFromRoot(value) {
  return path.isAbsolute(value) ? value : path.join(ROOT, value);
}

export async function loadConfig(configPath = path.join(ROOT, "config", "default.json")) {
  const defaultPath = path.join(ROOT, "config", "default.json");
  const defaults = JSON.parse(await readFile(defaultPath, "utf8"));
  const raw = configPath === defaultPath ? {} : JSON.parse(await readFile(configPath, "utf8"));
  const config = merge(defaults, raw);
  if (!config.loginUrl) throw new Error("配置缺少 loginUrl");
  return {
    ...config,
    paths: {
      ...config.paths,
      userDataDir: resolveFromRoot(config.paths.userDataDir),
      artifactsDir: resolveFromRoot(config.paths.artifactsDir),
      reportPath: resolveFromRoot(config.paths.reportPath),
      htmlReportPath: resolveFromRoot(config.paths.htmlReportPath)
    }
  };
}

export function validateConfig(config) {
  const errors = [];
  if (!/^https?:\/\//u.test(config.loginUrl ?? "")) errors.push("loginUrl 必须是 HTTP(S) URL");
  if (config.proxy?.server && !/^https?:\/\//u.test(config.proxy.server)) errors.push("proxy.server 必须是 HTTP(S) 代理 URL");
  if (config.browser?.viewport && (config.browser.viewport.width < 640 || config.browser.viewport.height < 480)) {
    errors.push("browser.viewport 尺寸过小");
  }
  return errors;
}
