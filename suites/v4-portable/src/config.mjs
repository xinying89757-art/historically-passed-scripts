import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(sourceDir, "..");

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function deepMerge(base, override) {
  const result = structuredClone(base);
  for (const [key, value] of Object.entries(override ?? {})) {
    if (isPlainObject(value) && isPlainObject(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = structuredClone(value);
    }
  }
  return result;
}

async function readJson(jsonPath) {
  return JSON.parse(await readFile(jsonPath, "utf8"));
}

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export async function loadConfig(overridePath) {
  const defaultPath = path.resolve(projectRoot, "config/default.json");
  const defaults = await readJson(defaultPath);
  const override = overridePath
    ? await readJson(resolveProjectPath(overridePath))
    : {};
  const config = deepMerge(defaults, override);

  config.inputCsv = resolveProjectPath(config.inputCsv);
  config.componentWorkbook = resolveProjectPath(config.componentWorkbook);
  if (config.rankingWorkbook) {
    config.rankingWorkbook = resolveProjectPath(config.rankingWorkbook);
  }
  if (config.v4Csv) {
    config.v4Csv = resolveProjectPath(config.v4Csv);
  }
  for (const key of [
    "userDataDir",
    "stateFile",
    "artifactsDir",
    "reportsDir",
    "componentStateFile",
    "componentArtifactsDir",
    "componentReportsDir",
    "v4StateFile",
    "v4ArtifactsDir",
    "v4ReportsDir",
  ]) {
    if (config.paths[key]) {
      config.paths[key] = resolveProjectPath(config.paths[key]);
    }
  }

  if (!Number.isInteger(config.blocksPerPage) || config.blocksPerPage < 1) {
    throw new Error("blocksPerPage 必须是大于 0 的整数");
  }
  if (!Number.isInteger(config.componentsPerPage) || config.componentsPerPage < 1) {
    throw new Error("componentsPerPage 必须是大于 0 的整数");
  }
  for (const required of [
    "inputCsv",
    "componentWorkbook",
    "componentSheetName",
    "editorUrl",
    "publicBaseUrl",
    "siteConfirmationHost",
  ]) {
    if (!config[required]) {
      throw new Error(`配置缺少 ${required}`);
    }
  }
  return config;
}

export function componentPageDescriptor(config, pageNumber) {
  const suffix = String(pageNumber).padStart(3, "0");
  return {
    number: pageNumber,
    name: `${config.componentPageNamePrefix}${suffix}`,
    path: `/${config.componentPagePathPrefix}${suffix}`,
    publicUrl: new URL(
      `/${config.componentPagePathPrefix}${suffix}`,
      config.publicBaseUrl,
    ).toString(),
  };
}

export function pageDescriptor(config, pageNumber) {
  const suffix = String(pageNumber).padStart(3, "0");
  return {
    number: pageNumber,
    name: `${config.pageNamePrefix}${suffix}`,
    path: `/${config.pagePathPrefix}${suffix}`,
    publicUrl: new URL(
      `/${config.pagePathPrefix}${suffix}`,
      config.publicBaseUrl,
    ).toString(),
  };
}
