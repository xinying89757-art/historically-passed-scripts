#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { deepMerge, loadConfig, projectRoot } from "./config.mjs";
import { launchV4Browser } from "./v4-editor.mjs";
import {
  createV4MirrorState,
  loadOrCreateV4MirrorState,
  readV4MirrorSources,
  runV4Mirror,
  summarizeV4Mirror,
} from "./v4-mirror.mjs";
import { writeV4MirrorReports } from "./v4-mirror-report.mjs";

function parseArgs(argv) {
  const result = { command: argv[2] ?? "status", apply: false, config: "config/v4-mirror-no-proxy.json", maxPages: 0 };
  for (let index = 3; index < argv.length; index += 1) {
    if (argv[index] === "--apply") result.apply = true;
    else if (argv[index] === "--config") result.config = argv[++index];
    else if (argv[index] === "--max-pages") result.maxPages = Number(argv[++index]);
  }
  if (!Number.isInteger(result.maxPages) || result.maxPages < 0) throw new Error("--max-pages必须是非负整数");
  return result;
}

function absolute(value) {
  return path.isAbsolute(value) ? value : path.resolve(projectRoot, value);
}

async function loadMirrorConfig(file) {
  const definition = JSON.parse(await readFile(absolute(file), "utf8"));
  const base = await loadConfig(definition.baseConfig);
  const config = deepMerge(base, {
    v4EntryUrl: definition.entryUrl,
    siteName: definition.siteName,
    siteLanguage: definition.siteLanguage,
    proxyServer: "",
    paths: { userDataDir: absolute(definition.userDataDir) },
  });
  config.proxyServer = "";
  const paths = {
    sourceBlockStateFile: absolute(definition.sourceBlockStateFile),
    sourceFirstRichTextStateFile: absolute(definition.sourceFirstRichTextStateFile),
    sourceBatchRichTextStateFile: absolute(definition.sourceBatchRichTextStateFile),
    targetExistingStateFile: definition.targetExistingStateFile ? absolute(definition.targetExistingStateFile) : "",
    stateFile: absolute(definition.stateFile),
    artifactsDir: absolute(definition.artifactsDir),
    reportsDir: absolute(definition.reportsDir),
  };
  const environment = {
    entryUrl: definition.entryUrl,
    siteName: definition.siteName,
    siteLanguage: definition.siteLanguage,
    proxyServer: "",
    allowExistingExtraBlocks: Boolean(definition.allowExistingExtraBlocks),
    userDataDir: config.paths.userDataDir,
    ...paths,
  };
  return { config, paths, environment };
}

async function plan(paths, environment) {
  const sources = await readV4MirrorSources(paths);
  const state = createV4MirrorState({ ...sources, environment });
  stdout.write(`${JSON.stringify({
    ...summarizeV4Mirror(state),
    entryUrl: environment.entryUrl,
    proxyServer: environment.proxyServer,
    pages: state.pages.map((page) => ({ name: page.name, category: page.category, blocks: page.records.length })),
  }, null, 2)}\n`);
}

async function auth(config) {
  const { context, page } = await launchV4Browser(config, { headless: false, slowMo: 0 });
  const terminal = createInterface({ input: stdin, output: stdout });
  try {
    await page.goto(config.v4EntryUrl, { waitUntil: "domcontentloaded" });
    stdout.write("已打开无代理登录页。完成登录后回到终端按Enter。\n");
    await terminal.question("");
  } finally {
    terminal.close();
    await context.close();
  }
}

async function status(paths, environment) {
  const state = await readFile(paths.stateFile, "utf8").then(JSON.parse).catch(() => null);
  if (!state) {
    stdout.write("尚无4.0无代理镜像状态\n");
    return;
  }
  await writeV4MirrorReports(state, paths.reportsDir);
  stdout.write(`${JSON.stringify({
    phase: state.phase,
    ...summarizeV4Mirror(state),
    stateFile: paths.stateFile,
    reportsDir: paths.reportsDir,
    proxyServer: environment.proxyServer,
  }, null, 2)}\n`);
}

const args = parseArgs(process.argv);
const { config, paths, environment } = await loadMirrorConfig(args.config);
if (args.command === "plan") await plan(paths, environment);
else if (args.command === "auth") await auth(config);
else if (args.command === "status" || args.command === "report") await status(paths, environment);
else if (["run", "resume"].includes(args.command)) {
  if (!args.apply) throw new Error(`${args.command}会修改4.0编辑器，必须显式包含--apply`);
  await loadOrCreateV4MirrorState(paths, environment);
  const state = await runV4Mirror({
    config,
    paths,
    environment,
    reportWriter: writeV4MirrorReports,
    maxPages: args.maxPages,
  });
  stdout.write(`${JSON.stringify({ phase: state.phase, ...summarizeV4Mirror(state), stateFile: paths.stateFile, reportsDir: paths.reportsDir }, null, 2)}\n`);
} else {
  throw new Error(`未知命令：${args.command}`);
}
