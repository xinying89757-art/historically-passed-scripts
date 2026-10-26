#!/usr/bin/env node
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROJECT_ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const VERSION = "v1.0.0";
const PACKAGE_ROOT_NAME = "leadong-automation-suite-" + VERSION;
const OUTPUT_DIR = path.join(PROJECT_ROOT, "outputs");
const ZIP_PATH = path.join(OUTPUT_DIR, PACKAGE_ROOT_NAME + ".zip");
const CHECKSUM_PATH = ZIP_PATH + ".sha256";
const COPY_DIRS = ["src", "scripts", "test"];
const COPY_FILES = ["package.json", "package-lock.json", "AUTOMATION-SCRIPT-INVENTORY.md", "SHARE-README.md"];
const CONFIG_FILES = [
  "default.json",
  "ranking-heading.json",
  "v3-full-heading.json",
  "v3-online-heading.json",
  "v4-blocks.json",
  "v4-mirror-no-proxy.json",
  "growth-engine-h.json",
  "growth-engine-h-v3-full.json",
  "growth-engine-h-v3-full-direct-recheck.json",
  "growth-engine-h-v3-online.json",
  "growth-engine-h-v3-preview-pilot.json",
  "growth-engine-h-v3-readonly-recheck.json",
  "growth-engine-h-v4-no-refresh.json",
];

// The share package emits the no-refresh v4 configuration under the
// historical default filename used by ge:v4:h:* commands.
const CONFIG_ALIASES = {
  "growth-engine-h-v4-no-refresh.json": ["growth-engine-h-v4-no-refresh.json", "growth-engine-h-v4.json"],
};

function assertNoRefreshConfig(config, file) {
  if (config.refreshBeforeEdit !== false) {
    throw new Error(`默认增长引擎配置必须关闭刷新：${file}`);
  }
  if (config.previewResolution?.preferDerived !== true) {
    throw new Error(`默认增长引擎配置必须启用自动拼接预览地址：${file}`);
  }
  if (config.previewResolution?.allowEditorFallback !== false) {
    throw new Error(`默认增长引擎配置禁止回退到旧预览地址：${file}`);
  }
}

function baseName(value) {
  const name = path.basename(String(value || "")).replaceAll("\\", "-").trim();
  return name || "value";
}

function scrubText(value) {
  return String(value)
    .replaceAll(/\/Users\/xinying\/Desktop\/[^"'\s]+/gu, "input/components.xlsx")
    .replaceAll(/\/Users\/xinying\/Library\/Containers\/[^"'\s]+/gu, "input/")
    .replaceAll(/\/Users\/xinying\/codex-vibecoding\/[^"']+/gu, "input/")
    .replaceAll(/en-site\d+\.ldmfyh\.com/gu, "YOUR_SITE_HOST")
    .replaceAll(/en-site\d+\.preview\.leadong\.com/gu, "YOUR_PREVIEW_HOST")
    .replaceAll(/http:\/\/jianzhan\.leadong\.com/gu, "https://www.leadong.com");
}

function sanitizeConfig(value, key = "") {
  if (Array.isArray(value)) return value.map((item) => sanitizeConfig(item, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizeConfig(childValue, childKey)]));
  }
  if (typeof value !== "string") return value;
  const k = key.toLowerCase();
  if (k === "inputcsv") return "input/blocks.csv";
  if (k === "componentworkbook") return "input/components.xlsx";
  if (k === "rankingworkbook") return "input/ranking.xlsx";
  if (k === "v4csv") return "input/v4-blocks.csv";
  if (k === "v3onlineworkbook") return "input/online-status.xlsx";
  if (k === "v3fullinputdir") return "input/v3-block-json";
  if (k.includes("workbook") || k.endsWith("csv")) return "input/" + baseName(value);
  if (k.includes("userdatadir")) return ".auth/" + baseName(value);
  if (k.includes("statefile")) return ".state/" + baseName(value);
  if (k.includes("artifactsdir")) return "artifacts/" + baseName(value);
  if (k.includes("reportsdir") || k.includes("outputdir")) return "reports/" + baseName(value);
  if (k === "proxy" || k === "proxyserver") return "";
  if (k.includes("siteconfirmationhost") || k.includes("sitehost") || k === "host") return "YOUR_SITE_HOST";
  if (k.includes("publicbaseurl") || k.includes("publicfallbackbaseurl")) return "http://YOUR_SITE_HOST";
  if (k === "publicurl") return "http://YOUR_PREVIEW_HOST/your-page-path";
  if (k === "sitename" || k === "growthenginesitename" || k === "name" || k === "site") return "YOUR_SITE_NAME";
  if (k === "sitelanguage") return "英语";
  if (k === "targetpagepath") return "/your-page-path";
  if (k === "pagename") return "YOUR_TEST_PAGE";
  if (k === "loginurl" || k === "entryurl" || k === "v4entryurl") return "https://www.leadong.com/website.html";
  if (k === "growthengineurl") return "https://www.leadong.com/phoenix2/composite/middle/platform/index.html";
  if (k === "editorurl") return "https://website.leadong.com/phoenix/pagebuilder/layout";
  return scrubText(value);
}

async function copyText(source, destination, transform = scrubText) {
  await writeFile(destination, transform(await readFile(source, "utf8")), "utf8");
}

async function createArchive(stagingRoot) {
  await mkdir(OUTPUT_DIR, { recursive: true });
  await rm(ZIP_PATH, { force: true });
  if (process.platform === "win32") {
    const source = stagingRoot.replaceAll("'", "''");
    const target = ZIP_PATH.replaceAll("'", "''");
    const command = "Compress-Archive -Path '" + source + "\\*' -DestinationPath '" + target + "' -Force";
    await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", command]);
  } else {
    await execFileAsync("zip", ["-qr", ZIP_PATH, PACKAGE_ROOT_NAME], { cwd: path.dirname(stagingRoot) });
  }
}

async function archiveEntries() {
  if (process.platform === "win32") {
    const target = ZIP_PATH.replaceAll("'", "''");
    const result = await execFileAsync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "tar -tf '" + target + "'"]);
    return result.stdout.split(/\r?\n/u).filter(Boolean);
  }
  const result = await execFileAsync("unzip", ["-Z1", ZIP_PATH]);
  return result.stdout.split(/\r?\n/u).filter(Boolean);
}

async function main() {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "leadong-share-"));
  const stagingRoot = path.join(temporaryRoot, PACKAGE_ROOT_NAME);
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const directory of COPY_DIRS) {
      await cp(path.join(PROJECT_ROOT, directory), path.join(stagingRoot, directory), { recursive: true, force: true });
    }
    for (const file of COPY_FILES) {
      const target = file === "SHARE-README.md" ? "README.md" : file;
      await copyText(path.join(PROJECT_ROOT, file), path.join(stagingRoot, target));
    }
    const configRoot = path.join(stagingRoot, "config");
    await mkdir(configRoot, { recursive: true });
    for (const file of CONFIG_FILES) {
      const parsed = JSON.parse(await readFile(path.join(PROJECT_ROOT, "config", file), "utf8"));
      if (file === "growth-engine-h.json" || file === "growth-engine-h-v4-no-refresh.json") {
        assertNoRefreshConfig(parsed, file);
      }
      const targets = CONFIG_ALIASES[file] ?? [file];
      for (const target of targets) {
        await writeFile(path.join(configRoot, target), JSON.stringify(sanitizeConfig(parsed), null, 2) + "\n", "utf8");
      }
    }
    await copyText(path.join(PROJECT_ROOT, "config", "README.md"), path.join(configRoot, "README.md"));
    await mkdir(path.join(stagingRoot, "input"), { recursive: true });
    await copyText(path.join(PROJECT_ROOT, "input", "README.md"), path.join(stagingRoot, "input", "README.md"));
    await writeFile(path.join(stagingRoot, "VERSION"), VERSION + "\n", "utf8");
    await createArchive(stagingRoot);
    const entries = await archiveEntries();
    const forbidden = entries.filter((entry) => /(^|\/)(?:\.auth|\.state|reports|artifacts)(?:\/|$)/u.test(entry));
    if (forbidden.length) throw new Error("压缩包包含禁止目录：" + forbidden.slice(0, 5).join(", "));
    if (entries.some((entry) => /\/Users\/|\/var\/folders\//u.test(entry))) throw new Error("压缩包包含本机绝对路径");
    const digest = createHash("sha256").update(await readFile(ZIP_PATH)).digest("hex");
    await writeFile(CHECKSUM_PATH, digest + "  " + path.basename(ZIP_PATH) + "\n", "utf8");
    await copyText(path.join(PROJECT_ROOT, "SHARE-README.md"), path.join(OUTPUT_DIR, PACKAGE_ROOT_NAME + "-README.md"));
    process.stdout.write(JSON.stringify({ zip: ZIP_PATH, sha256: CHECKSUM_PATH, entries: entries.length }, null, 2) + "\n");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write((error.stack || error.message) + "\n");
  process.exitCode = 1;
});
