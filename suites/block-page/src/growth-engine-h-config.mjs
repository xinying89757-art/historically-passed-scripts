import { readFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./config.mjs";

function resolveProjectPath(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

export async function loadGrowthEngineConfig(configPath = "config/growth-engine-h.json") {
  const absoluteConfigPath = resolveProjectPath(configPath);
  const config = JSON.parse(await readFile(absoluteConfigPath, "utf8"));
  for (const required of ["loginUrl", "growthEngineUrl", "targetPagePath", "publicUrl"]) {
    if (!config[required]) throw new Error(`增长引擎配置缺少 ${required}`);
  }
  if (!config.proxyServer && !config.allowDirectConnection) {
    throw new Error("增长引擎配置缺少 proxyServer；如需直连请显式设置 allowDirectConnection=true");
  }
  if (config.editorBackfill?.enabled) {
    for (const required of ["siteName", "siteHost", "siteLanguage", "pageName"]) {
      if (!config.editorBackfill[required]) {
        throw new Error(`增长引擎编辑器回填配置缺少 editorBackfill.${required}`);
      }
    }
    if (config.editorBackfill.recordRemapStateFile) {
      config.editorBackfill.recordRemapStateFile = resolveProjectPath(config.editorBackfill.recordRemapStateFile);
    }
  }
  for (const key of ["userDataDir", "stateFile", "artifactsDir", "reportsDir"]) {
    config.paths[key] = resolveProjectPath(config.paths[key]);
  }
  if (config.batch) {
    for (const key of [
      "componentStateFile", "rankingStateFile", "stateFile", "pagesStateDir",
      "artifactsDir", "reportsDir",
    ]) {
      if (!config.batch[key]) throw new Error(`增长引擎批量配置缺少 batch.${key}`);
      config.batch[key] = resolveProjectPath(config.batch[key]);
    }
  }
  if (config.v4Source) {
    for (const key of ["firstPageStateFile", "batchStateFile", "editorConfigFile"]) {
      if (!config.v4Source[key]) throw new Error(`增长引擎4.0配置缺少 v4Source.${key}`);
      config.v4Source[key] = resolveProjectPath(config.v4Source[key]);
    }
  }
  if (config.v4Batch) {
    for (const key of [
      "stateFile", "pagesStateDir", "artifactsDir", "reportsDir", "priorPageStateFile",
    ]) {
      if (!config.v4Batch[key]) throw new Error(`增长引擎4.0批量配置缺少 v4Batch.${key}`);
      config.v4Batch[key] = resolveProjectPath(config.v4Batch[key]);
    }
  }
  if (config.v4Audit) {
    for (const key of ["sourceBlockStateFile", "sourceRichTextFile", "stateFile", "artifactsDir", "reportsDir"]) {
      if (!config.v4Audit[key]) throw new Error(`增长引擎4.0审计配置缺少 v4Audit.${key}`);
      config.v4Audit[key] = resolveProjectPath(config.v4Audit[key]);
    }
  }
  if (config.v4SupplementAudit) {
    for (const key of ["sourceBlockStateFile", "sourceMirrorStateFile", "stateFile", "artifactsDir", "reportsDir", "outputDir"]) {
      if (!config.v4SupplementAudit[key]) throw new Error(`增长引擎4.0补充核查配置缺少 v4SupplementAudit.${key}`);
      config.v4SupplementAudit[key] = resolveProjectPath(config.v4SupplementAudit[key]);
    }
  }
  if (config.v3ReadonlyRecheck) {
    for (const key of ["sourceWorkbook", "stateFile", "artifactsDir", "reportsDir", "outputDir"]) {
      if (!config.v3ReadonlyRecheck[key]) throw new Error(`增长引擎3.0只读回归配置缺少 v3ReadonlyRecheck.${key}`);
      config.v3ReadonlyRecheck[key] = resolveProjectPath(config.v3ReadonlyRecheck[key]);
    }
  }
  return config;
}
