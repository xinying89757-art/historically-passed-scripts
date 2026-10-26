#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const placeholder = /(?:\.example\.invalid\b|\bYOUR_[A-Z_]+\b|\$\{ARCHIVE_WORKSPACE\}|input\/LOCAL_FILE)/;
export function validateConfig(value, prefix = '') {
  const errors = [];
  if (Array.isArray(value)) {
    value.forEach((item, index) => errors.push(...validateConfig(item, `${prefix}[${index}]`)));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) errors.push(...validateConfig(item, prefix ? `${prefix}.${key}` : key));
  } else if (typeof value === 'string' && placeholder.test(value)) {
    errors.push(`${prefix}: 仍为归档占位值`);
  } else if (typeof value === 'string' && /(?:^|\.)(?:account|password|pagePassword)$/.test(prefix) && !value.trim()) {
    errors.push(`${prefix}: 缺少本机凭据`);
  }
  return errors;
}
export async function main(argv = process.argv.slice(2)) {
  const [suite, command, ...rest] = argv;
  const specs = JSON.parse(await fs.readFile(path.join(root, 'catalog/suites.json'), 'utf8'));
  if (!specs.some(item => item.id === suite)) throw new Error('请指定 catalog/suites.json 中的套件 ID。');
  const at = rest.indexOf('--archive-config');
  if (at < 0 || !rest[at + 1] || rest[at + 1].startsWith('--')) {
    throw new Error('缺少配置：请用 --archive-config <本机 JSON> 指定已填写的实际运行配置；原命令参数放在 -- 后。');
  }
  const cwd = path.join(root, 'suites', suite);
  const configPath = path.resolve(cwd, rest[at + 1]);
  let config;
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')); }
  catch { throw new Error('无法读取本机 JSON 配置。请先复制模板并填写实际测试环境。'); }
  if (!config || typeof config !== 'object' || Array.isArray(config) || !Object.keys(config).length) {
    throw new Error('本机配置必须是非空 JSON 对象。');
  }
  const errors = validateConfig(config);
  if (errors.length) throw new Error(`运行配置尚未完成：\n${errors.join('\n')}`);
  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  rest.splice(at, 2);
  const separator = rest.indexOf('--');
  if (separator >= 0) rest.splice(separator, 1);
  let executable, args;
  if (command === '--file') {
    const filename = rest.shift();
    const file = path.resolve(cwd, filename ?? '');
    if (!filename || !file.startsWith(cwd + path.sep) || !/\.(?:mjs|js|sh)$/.test(file)) throw new Error('--file 必须指定套件内的 JS 或 Shell 文件。');
    await fs.access(file);
    executable = file.endsWith('.sh') ? 'bash' : process.execPath;
    args = [file, ...rest];
  } else {
    if (!command || !Object.hasOwn(pkg.scripts ?? {}, command)) throw new Error('套件 package.json 中不存在该脚本命令。');
    executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    args = ['run', command, '--', ...rest];
  }
  const child = spawn(executable, args, { cwd, stdio: 'inherit', env: process.env, shell: false });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
