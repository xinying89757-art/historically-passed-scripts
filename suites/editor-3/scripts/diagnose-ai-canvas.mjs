import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, projectRoot } from '../src/config.mjs';
import { LeadongEditor, launchEditorBrowser } from '../src/editor.mjs';

const config = await loadConfig();
const { context, page } = await launchEditorBrowser(config, { headless: false, isolatedProfile: false });
try {
  const editor = new LeadongEditor(page, config);
  await editor.goto();
  await editor.openCustomPage(process.argv[2] || 'AI区块类型回归-001-regression-20260928144759');
  await page.waitForTimeout(5000);
  const frames = [];
  for (const frame of page.frames()) {
    const snapshot = await frame.evaluate(() => {
      const root = document.querySelector('#backstage-bodyArea');
      if (!root) return null;
      return {
        body: true,
        nodes: [...root.querySelectorAll(".backstage-blocksEditor-wrap, .siteblocks-setting-wrap, .ai-generated-block, .block-container")].map(n => ({
          id: n.id, classes: n.className, parent: n.parentElement?.id,
          visible: !!n.getClientRects().length,
          text: (n.innerText || '').slice(0, 160),
        })),
      };
    }).catch(() => null);
    frames.push({ url: frame.url().split('?')[0], snapshot });
  }
  const dir = path.join(projectRoot, 'output/playwright');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'ai-canvas-diagnosis.png'), fullPage: false });
  console.log(JSON.stringify({ frames }, null, 2));
} finally { await context.close(); }
