import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { LeadongEditor, launchEditorBrowser } from '../src/editor.mjs';
import { AiPagedAutomation } from '../src/ai-paged-runner.mjs';

// Read-only history recovery: never generate, save, publish, or click final
// Apply. Explicit commands operate only inside the temporary AI result.
const source = process.argv[2];
if (!source) throw new Error('需要指定本轮 page-003.json');
const state = JSON.parse(await readFile(source, 'utf8'));
const record = state.types.find(item => item.type === '产品筛选');
if (!record || record.generation_status !== 'succeeded') throw new Error('没有可诊断的成功产品筛选记录');
const config = await loadConfig();
config.ai.runId = `filter-diagnosis-${Date.now()}`;
const dir = path.join(projectRoot, 'output/playwright', config.ai.runId);
await mkdir(dir, { recursive: true });
const { context, page } = await launchEditorBrowser(config, { headless: false, isolatedProfile: false });
const input = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  const editor = new LeadongEditor(page, config);
  await editor.goto();
  await editor.openCustomPage(state.page.name);
  const runner = new AiPagedAutomation(editor, config, { save: async () => {} }, 3);
  runner.state = state;
  runner.page = state.page;
  runner.bindHandlers();
  const ai = await runner.openAiDialog();
  const history = await runner.historyRecord(ai, record);
  await history.insert.click();
  await page.waitForTimeout(1000);
  const module = ai.getByRole('button', { name: '应用模块', exact: true }).first();
  if (await module.isVisible()) await module.click();
  const match = await runner.filterHandler.generatedBlock(ai);
  const scopes = () => page.frames().filter(frame => {
    for (let ancestor = frame; ancestor; ancestor = ancestor.parentFrame()) if (ancestor === ai) return true;
    return false;
  });
  let number = 0;
  const snapshot = async () => {
    const data = [];
    for (const [index, frame] of scopes().entries()) {
      data.push({ index, url: frame.url().split('?')[0], nodes: await frame.evaluate(() => {
        const nodes = document.querySelectorAll('.phoenix2-block-wrap, [data-gjs-type], .block-setting-toolbar-item, .ld-component-toolbar-item, .el-drawer, label.el-checkbox');
        return [...nodes].slice(0, 180).map(node => {
          const r = node.getBoundingClientRect();
          return { id: node.id, tag: node.tagName, classes: String(node.className), type: node.getAttribute('data-gjs-type'),
            text: (node.innerText || '').slice(0, 150), visible: !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden',
            rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        });
      }) });
    }
    await writeFile(path.join(dir, `snapshot-${number}.json`), JSON.stringify(data, null, 2));
    await page.screenshot({ path: path.join(dir, `snapshot-${number++}.png`), fullPage: false });
    console.log(JSON.stringify({ artifactDir: dir, frames: data }, null, 2));
  };
  await snapshot();
  while (true) {
    const command = await input.question('snapshot | select <frame> <selector> | gear | configure | quit > ');
    if (command === 'quit') break;
    if (command === 'snapshot') await snapshot();
    else if (command === 'gear') {
      const gear = ai.locator('.block-setting-toolbar-item:has(.icon-tool-setups):visible');
      if (await gear.count() !== 1) throw new Error('设置按钮不唯一');
      await gear.click();
      await page.waitForTimeout(1500);
      await snapshot();
    } else if (command === 'configure') {
      await runner.filterHandler.configureFilterBeforeApply(ai, record).catch(error => console.log(error.message));
      await snapshot();
    } else if (command.startsWith('select ')) {
      const [, index, ...selector] = command.split(' ');
      const target = scopes()[Number(index)]?.locator(selector.join(' '));
      if (!target || await target.count() !== 1) throw new Error('选中目标必须唯一');
      await target.click();
      await page.waitForTimeout(500);
      await snapshot();
    }
  }
  await runner.closeAiResult();
} finally { input.close(); await context.close(); }
