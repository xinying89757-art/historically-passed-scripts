import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { LeadongEditor } from "../src/editor.mjs";

function auditConfig() {
  return {
    timeouts: {
      actionMs: 2000,
      blockRenderMs: 2000,
    },
    selectors: {
      editorFrameUrlIncludes: "/phoenix/pagebuilder?",
      blockRootTemplates: [
        "[data-block-id='{id}']",
        "[data-module-id='{id}']",
      ],
      renderErrorTexts: ["渲染失败"],
      loadingSelectors: [".loading", "[aria-busy='true']"],
    },
  };
}

test("auditBlock 识别唯一根节点、H 标签、图片和默认内容", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main data-block-id="40748" style="width:600px;height:200px">
      <h2>默认标题</h2>
      <p>默认正文</p>
      <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'/%3E"
           alt="默认图片" width="20" height="20">
    </main>
  `);
  const editor = new LeadongEditor(page, auditConfig());
  const audits = await editor.auditBlock("40748");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].heading_counts.h2, 1);
  assert.equal(audits[0].image_count, 1);
  assert.equal(audits[0].has_default_content, true);
  assert.equal(audits[0].loading, false);
});

test("auditBlock 将可见视频视为有效默认内容", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <section data-block-id="28884" style="width:900px;height:150px">
      <video src="https://example.test/demo.mp4"
             style="display:block;width:900px;height:150px"></video>
    </section>
  `);
  const editor = new LeadongEditor(page, {
    selectors: {
      blockRootTemplates: ["[data-block-id='{id}']"],
      renderErrorTexts: [],
      loadingSelectors: [],
    },
  });
  const audits = await editor.auditBlock("28884");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].media_count, 1);
  assert.equal(audits[0].has_default_content, true);
});

test("waitForBlockAudit 拒绝重复 block_id", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <section data-block-id="88" style="width:20px;height:20px">A</section>
    <section data-block-id="88" style="width:20px;height:20px">B</section>
  `);
  const editor = new LeadongEditor(page, auditConfig());
  const result = await editor.waitForBlockAudit("88");
  assert.equal(result.outcome, "render_failed");
  assert.match(result.reason, /检测到 2 个/);
});

test("waitForBlockAudit 无任何插入信号时使用较短超时", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent("<main>空白页面</main>");
  const config = auditConfig();
  config.timeouts.blockRenderMs = 2000;
  config.timeouts.blockNoSignalMs = 150;
  const editor = new LeadongEditor(page, config);
  const startedAt = Date.now();
  const result = await editor.waitForBlockAudit("999");
  assert.equal(result.outcome, "render_failed");
  assert.match(result.reason, /没有检测到目标 DOM 或加载信号/);
  assert.ok(Date.now() - startedAt < 1200);
});

test("savePage 点击右上角保存并以保存接口 200 作为成功凭证", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("**/phoenix/pagebuilder/savegridlayout", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ success: true }),
    });
  });
  await page.setContent(`
    <button id="saveLayout" onclick="
      fetch('https://example.test/phoenix/pagebuilder/savegridlayout', {
        method: 'POST'
      })
    ">保存</button>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: { saveMs: 2000 },
    selectors: {
      saveTexts: ["^保存$"],
      saveSuccessTexts: ["保存成功"],
    },
  });
  const result = await editor.savePage();
  assert.equal(result.evidence, "network");
  assert.equal(result.status, 200);
});

test("searchAndAdd 按回车后无结果时直接记录 not_found，不操作已隐藏输入框", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <a id="plus">添加区块到内容区</a>
    <section class="backstage-addmodules-chooseWrapper-new"
             style="position:fixed;left:-500px;top:10px;width:481px;height:300px">
      <input id="search" placeholder="请输入区块ID或标签，进行搜索">
      <span>没有数据</span>
    </section>
    <script>
      document.querySelector('#plus').onclick = () => {
        window.plusClicks = (window.plusClicks || 0) + 1;
        const panel = document.querySelector('.backstage-addmodules-chooseWrapper-new');
        panel.classList.add('on');
        panel.style.left = '0';
      };
      document.querySelector('#search').addEventListener('keydown', (event) => {
        if (event.key === 'Enter') event.target.style.visibility = 'hidden';
      });
    </script>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: { actionMs: 2000, searchResultMs: 2000 },
    selectors: {
      blockSearchPlaceholders: ["请输入区块ID或标签，进行搜索"],
      contentAddTexts: [],
      contentAddSelectors: ["#plus"],
      addButtonTexts: ["^添加$"],
      noBlockResultTexts: ["没有数据"],
    },
  });
  const result = await editor.searchAndAdd("16294");
  assert.equal(result.outcome, "not_found");
  assert.equal(await page.evaluate(() => window.plusClicks), 1);
});

test("locateExactBlockResult 先悬浮结果卡片再识别添加按钮", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      #card .btn { display:none }
      #card:hover .btn.preview { display:block }
    </style>
    <li id="card" style="width:300px;height:150px">
      <div class="blockID">
        区块ID：888
        <button class="btn preview">添加</button>
        <button class="btn add" appid="888">添加</button>
      </div>
    </li>
  `);
  const editor = new LeadongEditor(page, {
    selectors: { addButtonTexts: ["^添加$"] },
  });
  const result = await editor.locateExactBlockResult("888");
  assert.equal(result.outcome, "found");
  assert.equal(await result.add.isVisible(), true);
});

test("locateExactBlockResult 对精确卡片保留原生添加节点兜底", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <li id="card" style="width:300px;height:150px">
      <div>
        区块ID：18094
        <button class="btn preview" style="display:none"
                onclick="window.nativeAddClicked = true">添加</button>
        <button class="btn add" appid="18094" style="display:none">添加</button>
      </div>
    </li>
  `);
  const editor = new LeadongEditor(page, {
    selectors: { addButtonTexts: ["^添加$"] },
  });
  const result = await editor.locateExactBlockResult("18094");
  assert.equal(result.outcome, "found");
  assert.equal(await result.add.isVisible(), false);
  await result.add.evaluate((element) => element.click());
  assert.equal(await page.evaluate(() => window.nativeAddClicked), true);
});

test("dismissPageMenu 关闭会遮挡区块结果卡片的页面下拉层", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main style="position:fixed;inset:0"></main>
    <div id="backstage_select_pages" class="on">
      <div class="backstage-topToolbar-menusubUl"
           style="width:400px;height:500px">页面列表</div>
    </div>
    <script>
      document.addEventListener('click', (event) => {
        if (!event.target.closest('#backstage_select_pages')) {
          document.querySelector('#backstage_select_pages').classList.remove('on');
        }
      });
    </script>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: { actionMs: 2000 },
  });
  await editor.dismissPageMenu();
  assert.equal(
    await page.locator("#backstage_select_pages").evaluate((element) =>
      element.classList.contains("on"),
    ),
    false,
  );
});

test("waitForExactBlockResult 等待异步出现的精确结果卡片", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main id="results"></main>
    <script>
      setTimeout(() => {
        document.querySelector('#results').innerHTML =
          '<li style="width:300px;height:120px"><span>区块ID：999</span><button>添加</button></li>';
      }, 1200);
    </script>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: { searchResultMs: 3000 },
    selectors: {
      addButtonTexts: ["^添加$"],
      noBlockResultTexts: [],
    },
  });
  const result = await editor.waitForExactBlockResult("999");
  assert.equal(result.outcome, "found");
});

test("waitForExactBlockResult 不因精确卡片按钮尚未显示而误判失败", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <style>
      #card .btn { display:none }
      body.ready #card:hover .btn.preview { display:block }
    </style>
    <li id="card" style="width:300px;height:120px">
      <div>
        区块ID：16864
        <button class="btn preview">添加</button>
        <button class="btn add" appid="16864">添加</button>
      </div>
    </li>
    <script>
      setTimeout(() => document.body.classList.add('ready'), 1500);
    </script>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: { searchResultMs: 3500 },
    selectors: {
      addButtonTexts: ["^添加$"],
      noBlockResultTexts: [],
    },
  });
  const result = await editor.waitForExactBlockResult("16864");
  assert.equal(result.outcome, "found");
  assert.match(await result.add.textContent(), /添加/);
});

test("searchAndAdd 在精确结果闪回默认列表前立即点击", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <section class="backstage-addmodules-chooseWrapper-new on"
             style="position:fixed;left:0;top:0;width:481px;height:500px">
      <input id="search" placeholder="请输入区块ID或标签，进行搜索">
      <main id="results"></main>
    </section>
    <main id="canvas"></main>
    <script>
      const results = document.querySelector('#results');
      document.querySelector('#search').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        setTimeout(() => {
          results.innerHTML = \`
            <li style="width:300px;height:120px">
              <span>区块ID：13064</span>
              <button class="btn add" appid="13064">添加</button>
            </li>\`;
          results.querySelector('.btn.add').onclick = () => {
            window.exactClicks = (window.exactClicks || 0) + 1;
            document.querySelector('#canvas').innerHTML =
              '<section data-block-id="13064" style="width:500px;height:120px">默认区块内容</section>';
          };
        }, 60);
        setTimeout(() => {
          results.innerHTML = \`
            <li style="width:300px;height:120px"><span>区块ID：40748</span><button class="btn add" appid="40748">添加</button></li>
            <li style="width:300px;height:120px"><span>区块ID：40718</span><button class="btn add" appid="40718">添加</button></li>\`;
        }, 350);
      });
    </script>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: {
      actionMs: 1000,
      searchResultMs: 1200,
      searchResultStableMs: 700,
      searchSubmitAttempts: 2,
      blockRenderMs: 1500,
      blockNoSignalMs: 500,
    },
    selectors: {
      blockSearchPlaceholders: ["请输入区块ID或标签，进行搜索"],
      addButtonTexts: ["^添加$"],
      noBlockResultTexts: [],
      blockRootTemplates: ["[data-block-id='{id}']"],
      renderErrorTexts: [],
      loadingSelectors: [],
    },
  });
  const result = await editor.searchAndAdd("13064");
  assert.equal(result.outcome, "added");
  assert.equal(await page.evaluate(() => window.exactClicks), 1);
});

test("searchAndAdd 搜索123同时出现123和1234时只添加精确ID", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <section class="backstage-addmodules-chooseWrapper-new on"
             style="position:fixed;left:0;top:0;width:481px;height:500px">
      <input id="search" placeholder="请输入区块ID或标签，进行搜索">
      <main id="results"></main>
    </section>
    <main id="canvas"></main>
    <script>
      document.querySelector('#search').addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        document.querySelector('#results').innerHTML = \`
          <li style="width:300px;height:120px"><span>区块ID：123</span><button class="btn add" appid="123">添加</button></li>
          <li style="width:300px;height:120px"><span>区块ID：1234</span><button class="btn add" appid="1234">添加</button></li>\`;
        document.querySelector('[appid="123"]').onclick = () => {
          window.exactClicks = (window.exactClicks || 0) + 1;
          document.querySelector('#canvas').innerHTML =
            '<section data-block-id="123" style="width:500px;height:120px">目标区块内容</section>';
        };
        document.querySelector('[appid="1234"]').onclick = () => {
          window.prefixClicks = (window.prefixClicks || 0) + 1;
        };
      });
    </script>
  `);
  const editor = new LeadongEditor(page, {
    timeouts: {
      actionMs: 1000,
      searchResultMs: 450,
      searchResultStableMs: 100,
      searchSubmitAttempts: 2,
      blockRenderMs: 1500,
      blockNoSignalMs: 500,
    },
    selectors: {
      blockSearchPlaceholders: ["请输入区块ID或标签，进行搜索"],
      addButtonTexts: ["^添加$"],
      noBlockResultTexts: [],
      blockRootTemplates: ["[data-block-id='{id}']"],
      renderErrorTexts: [],
      loadingSelectors: [],
    },
  });
  const result = await editor.searchAndAdd("123");
  assert.equal(result.outcome, "added");
  assert.equal(await page.evaluate(() => window.exactClicks || 0), 1);
  assert.equal(await page.evaluate(() => window.prefixClicks || 0), 0);
});

test("createCustomPage 按 3.0 → 空白页 → 页面设置链路填写名称和 URL", async (context) => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  context.after(() => browser.close());
  const page = await browser.newPage();
  let createAttempts = 0;
  await page.route("**/phoenix/page/setting", async (route) => {
    createAttempts += 1;
    await route.fulfill({
      status: createAttempts === 1 ? 502 : 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({ success: createAttempts > 1 }),
    });
  });
  await page.setContent(`
    <div id="backstage_select_pages"><span>页面:</span><a href="#">Home</a></div>
    <div id="layer"></div>
    <script>
      const layer = document.querySelector('#layer');
      document.querySelector('#backstage_select_pages a').onclick = (event) => {
        event.preventDefault();
        layer.innerHTML = '<button>自定义页面</button><button id="new-page">新建页面</button>';
        document.querySelector('#new-page').onclick = () => {
          layer.innerHTML = \`
            <section>
              <div class="editor-card"><strong>网页编辑器3.0</strong><p>继续使用当前网页编辑器</p><button id="editor-create">创建页面</button></div>
            </section>\`;
          document.querySelector('#editor-create').onclick = () => {
            layer.innerHTML = '<button id="blank">+ 添加空白页</button><button id="choose">选取</button>';
            document.querySelector('#choose').onclick = () => {
              layer.innerHTML = \`
                <div role="dialog">
                  <h2>页面设置</h2>
                  <h3>页面名称</h3><input>
                  <h3>页面URL</h3><input>
                  <button id="confirm">确定</button>
                </div>\`;
              document.querySelector('#confirm').onclick = () => {
                const inputs = [...layer.querySelectorAll('input')];
                window.confirmClicks = (window.confirmClicks || 0) + 1;
                fetch(
                  'https://example.test/phoenix/page/setting',
                  { method: 'POST' }
                );
                if (window.confirmClicks < 2) return;
                window.createdPage = { name: inputs[0].value, path: inputs[1].value };
                document.querySelector('#backstage_select_pages a').textContent = inputs[0].value;
                layer.innerHTML = '<div id="backstage-bodyArea"><a class="backstage-creatmodules-addbtn">+</a></div>';
              };
            };
          };
        };
      };
    </script>
  `);
  const config = {
    timeouts: { actionMs: 2000, blockRenderMs: 2000 },
    selectors: {
      pageMenuTexts: ["^页面\\s*[:：]"],
      customPageTexts: ["^自定义页面$"],
      newPageTexts: ["新建页面"],
      editor3CardTexts: ["网页编辑器3\\.0", "继续使用当前网页编辑器"],
      editorCreateTexts: ["^创建页面$"],
      blankPageTexts: ["添加空白页"],
      templateConfirmTexts: ["^选取$"],
      pageSettingsTexts: ["^页面设置$"],
      pageNameLabels: ["页面名称"],
      pageNamePlaceholders: ["请输入页面名称"],
      pagePathLabels: ["页面URL"],
      pagePathPlaceholders: ["请输入页面URL"],
      createConfirmTexts: ["^确定$"],
      pageCreateResponseUrlIncludes: "/phoenix/page/setting",
    },
  };
  const editor = new LeadongEditor(page, config);
  await editor.createCustomPage({
    name: "GE-区块测试-001",
    path: "/ge-block-test-001",
  });
  assert.deepEqual(await page.evaluate(() => window.createdPage), {
    name: "GE-区块测试-001",
    path: "/ge-block-test-001",
  });
  assert.equal(createAttempts, 2);
});
